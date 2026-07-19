# Provider and Generation Spec

## Purpose

This spec defines how Recursion selects providers, runs generation jobs, validates structured outputs, and records diagnostics for the SillyTavern extension.

Recursion borrows the Directive-style two-lane provider model, but keeps the surface smaller: Utility is the default worker for fast structured jobs, and Reasoner is an optional synthesis pass for difficult prompt-composition cases. Recursion is pre-alpha, so implementations should update old or provisional code in place to match this contract rather than preserve incompatible legacy behavior.

Related documents:

- [Product Scope](../design/RECURSION_PRODUCT_SCOPE.md)
- [Runtime Architecture](RUNTIME_ARCHITECTURE.md)
- [Card System Spec](../design/CARD_SYSTEM_SPEC.md)
- [Behavior Settings Policy Spec](../design/BEHAVIOR_SETTINGS_POLICY_SPEC.md)
- [Prompt Composition Spec](PROMPT_COMPOSITION_SPEC.md)
- [Storage and Diagnostics](STORAGE_AND_DIAGNOSTICS.md)
- [UI Spec](../design/UI_SPEC.md)

## Provider Lanes

Recursion has two provider lanes.

| Lane | Default use | Expected behavior | User-facing posture |
| --- | --- | --- | --- |
| Utility | Arbiter, scene/card extraction, card generation, lifecycle support, structured diagnostics | Fast, cheap, bounded, JSON-first, tolerant of being batched | Required operational lane |
| Reasoner | Optional composition/fusion of crowded, ambiguous, or conflicted card hands | Slower, smarter, synthesis-oriented, still evidence-bound | Optional, capability-gated |

Utility is the operational backbone. It should handle the initial Arbiter call and normal card generation without needing a Reasoner handoff.

Reasoner is not a better default Utility. It is a narrow composer lane used when Recursion already has structured Utility outputs and needs sharper guidance from a crowded or conflicted hand. Reasoner must not create new lore, hidden motives, durable canon, or private chain-of-thought artifacts.

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
  configRevision: number;
  resolvedProviderLabel?: string;
  resolvedModelLabel?: string;
  health: {
    status: "pass" | "fail" | "not-run";
    configHash?: string;
    checkedAt?: string;
    compactError?: string;
  };
};
```

There is no provider `enabled` Boolean. Provider capability is derived by one
shared resolver from the lane configuration, selected source requirements, host
support, session credential presence, and health evidence bound to the current
configuration hash:

| Capability | Meaning |
| --- | --- |
| `unconfigured` | The selected route lacks required data, host support, or a session credential. |
| `untested` | The route is complete, but no pass/fail evidence matches its current configuration hash. |
| `ready` | A passing health result matches the current configuration hash. |
| `unhealthy` | A failing health result matches the current configuration hash. |

Configuration and health mutations are separate. A field-scoped configuration
commit supplies the exact expected `configRevision`; a successful material
change increments the revision and invalidates prior health. A no-op preserves
both. Provider-test completion records only pass/fail health for the hash it
tested, so a stale result cannot overwrite newer configuration or establish
readiness for it.

The high-level Recursion settings also include `reasoningLevel: "low" | "medium" | "high" | "ultra"` as the authoritative user-facing provider-bias control. It defaults to `medium`. V1 derives the internal Reasoner route preference from it: Low selects Utility-only routing, while Medium, High, and Ultra use Reasoner for policy-selected work when its capability is `ready`. The companion card-budget settings are `minCards` and `maxCards`; runtime derives `normalCards = floor((minCards + maxCards) / 2)`.

Reasoning Level also controls runtime lane preference and card pressure:

| Level | Arbiter lane | Card lanes | Composer | Card pressure |
| --- | --- | --- | --- | --- |
| Low | Utility | Utility | Utility | Cap positive `maxCards` at Min Cards. |
| Medium | Utility | Utility | Reasoner | Cap positive `maxCards` at Normal Cards. |
| High | Reasoner when healthy | Reasoner for high-priority families, Utility for lower-priority families | Reasoner | Cap positive `maxCards` at Normal Cards. |
| Ultra | Reasoner when healthy | Reasoner when healthy | Reasoner | Raise and cap positive `maxCards` at Max Cards. |

If Reasoner is not `ready`, ordinary Medium/High/Ultra work falls back to
Utility instead of blocking host generation. Medium+ Redirect is the deliberate
exception: it is unavailable and settles as a preflight skip because its writer
and verifier require Reasoner. Low Redirect remains on Utility.

Reasoning Level also maps to provider-level reasoning intent for model calls that actually use the Reasoner lane:

| Work category | Low | Medium | High | Ultra |
| --- | --- | --- | --- | --- |
| Guidance augmentation / `reasonerComposer` | minimal | medium | medium | high |
| Arbiter on Reasoner | minimal | minimal | medium | medium |
| Card generation on Reasoner | minimal | minimal | minimal | medium |
| Provider tests | minimal | minimal | minimal | minimal |

Provider reasoning intent is request metadata, not prompt text. OpenAI-compatible adapters apply it only for known dialects: OpenRouter and OpenAI receive `reasoning: { effort, exclude: true }`; GLM/Z.AI receives `thinking: { type: "enabled" }` plus `reasoning_effort`; MiniMax M3 receives `thinking: "adaptive"` or `"enabled"`; DeepSeek reasoner and unknown endpoints receive no speculative reasoning fields. If a known endpoint rejects reasoning fields with a 400/422 unsupported-parameter response, the adapter retries once without reasoning fields and records `reasoningDowngraded: true` in sanitized diagnostics.

Source options:

- `host-current-model`: use the model currently active in SillyTavern.
- `host-connection-profile`: use a named SillyTavern connection profile.
- `openai-compatible`: use a direct OpenAI-compatible endpoint with base URL, model, session API key, temperature, top-p, and max token controls.

V1 should implement all three source options for Utility and Reasoner when the host exposes the required APIs. If a host cannot support connection profiles, the setting should be unavailable with a clear UI status rather than silently mapped to the current model.

Utility and Reasoner provider settings default to `8192` max tokens. The configured lane value is the authoritative response ceiling for every provider source. Provider Test uses that configured ceiling, including the untouched `8192` default, rather than a smaller hidden cap. Other callers may supply a narrower per-request response length, but a request may never exceed the configured lane ceiling.

Provider setup uses the same control-plane helpers as generation:

- Connection-profile discovery is a host-adapter capability. Provider core accepts an already discovered profile list or a host capability callback; it does not inspect SillyTavern globals.
- `listProviderConnectionProfiles()` delegates to the active host capability or explicit callback and otherwise returns an empty list.
- `providerModelStatus()` resolves the selected source into a compact readiness label before a test call runs, including selected connection profile model labels when the host exposes them.
- `fetchOpenAICompatibleModels()` discovers direct endpoint models by normalizing the configured base URL to `/models` and parsing OpenAI-style `data[]` or `models[]` responses.

Provider core is host-neutral. Host connection-profile discovery is supplied by the active host adapter; OpenAI-compatible endpoint model discovery remains provider-core behavior because it belongs to the endpoint contract rather than the SillyTavern object graph.

Connection profile discovery must stay scoped to provider/connection-profile seams. It must not traverse SillyTavern character, character-card, persona, avatar, group, or Recursion card containers while searching for profiles. The Providers pane should reuse one detected profile list while rendering Utility and Reasoner controls instead of asking the host repeatedly during a single render. The Profile control is a filterable combobox: typed text filters the local detected list, and persisted provider settings change only after the user chooses a detected profile entry.

Model discovery is read-only. It may use the currently typed session key, but it must not save settings, persist secrets, write diagnostics, clear prompts, or invalidate scene cache. Fetch failures are compact UI status, not runtime generation failures.

The Providers settings pane shows a compact route summary derived from Reasoning Level. Recursion does not expose Directive-style deep per-role routing controls in V1; Reasoning Level remains the operator-facing route control, and runtime owns the detailed role-to-lane policy.

Machine JSON calls carry the expected response schema as provider request metadata. Host connection profile calls pass a minimal JSON schema constraint to `ConnectionManagerRequestService.sendRequest` when available and suppress host preset/instruct wrapping for those machine-readable Recursion jobs. The schema constrains the response `schema` field and, when the request has a frozen `snapshotHash`, the response `snapshotHash` field. This keeps saved SillyTavern profiles useful for routing while avoiding accidental roleplay preset text around strict JSON contracts. Human-facing SillyTavern generation remains outside Recursion's provider-job wrapper.

Host current-model calls pass normalized `reasoningIntent`, `reasoningCategory`, and nested `reasoning` metadata to raw host adapters when a caller provides reasoning intent. Host connection-profile calls pass both Recursion's normalized `parameters.reasoning = { intent, category, exclude: true }` metadata and SillyTavern's native `reasoning_effort` plus `include_reasoning: false` fields. The native fields are required for Connection Manager's OpenRouter backend to apply the requested effort instead of silently using a `:thinking` model's default reasoning budget. Recursion never stores or exposes hidden reasoning content.

Utility always has a settings object. If its capability is not `ready`,
Recursion degrades to cached/local behavior and does not block normal
SillyTavern generation.

Reasoner is optional. Medium, High, and Ultra keep their selected UI level when
its capability is not `ready`; ordinary work falls back to Utility, while
Medium+ Redirect remains visibly unavailable.

Provider Test is single-flight per lane. Concurrent callers for the same lane
share the in-flight test. A test requested while production work is active on
that lane returns `RECURSION_PROVIDER_BUSY`; it does not cancel, supersede, or
race the production request.

The first working loop must include:

- Utility provider settings and test action;
- Reasoner provider settings and test action;
- Utility Arbiter structured call;
- Utility guidance path through `guidanceComposer`;
- Reasoner composition path through `reasonerComposer`;
- Utility guidance plus raw selected Card Evidence as the default and fallback packet path.

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

Persisted settings may record only `sessionApiKeyPresent: true | false` so the UI can show that the current browser session has a key loaded. Clearing a session key must remove it from memory and immediately mark the lane untestable until a key is re-entered. Changing source, host connection profile, base URL, model, max tokens, or session key must clear stale provider-test pass state and resolved provider/model labels.

Provider requests may receive the key through an in-memory provider runtime object. The key must not be copied into request hashes, error text, telemetry payloads, or thrown exceptions.

## Generation Roles

Generation roles describe why a model call exists. They are not the same thing as provider lanes. Each role declares its default lane, output schema, and failure behavior.

| Role | Default lane | Purpose | Failure behavior |
| --- | --- | --- | --- |
| `utilityArbiter` | Utility, Reasoner at High/Ultra when healthy | Decide whether Recursion should skip, reuse cache, refresh cards, compose a packet, infer story tense/POV, and optionally invoke Reasoner | Unavailable lane reuses valid cache or skips injection; invalid schema or missing/mismatched `snapshotHash` uses conservative local fallback |
| `sceneFrameCard` | Utility, Reasoner at High/Ultra when healthy | Produce compact current-scene frame data | Omit card with diagnostic |
| `activeCastCard` | Utility, Reasoner at High/Ultra when healthy | Capture who is present, visible state, and current conversational or physical role | Omit card with diagnostic |
| `characterMotivationCard` | Utility, Reasoner at High/Ultra when healthy | Capture observable or safely inferred motives, pressures, hesitations, and goals | Omit card with diagnostic |
| `dialogueRelationshipCard` | Utility, Reasoner at Ultra when healthy | Capture current conversational tension, relationship texture, promises, conflicts, and voice constraints | Omit card with diagnostic |
| `socialSubtextCard` | Utility, Reasoner at Ultra when healthy | Capture scene-observable implied social meaning such as humor, veiled pressure, invitation, boundaries, status, and face | Omit card with diagnostic |
| `sceneConstraintsCard` | Utility, Reasoner at High/Ultra when healthy | Identify hard scene constraints, contradiction traps, timing, access, and plausibility risks for the next generation | Omit card with diagnostic |
| `knowledgeSecretsCard` | Utility, Reasoner at High/Ultra when healthy | Capture concealed facts, who knows or suspects them, mistaken beliefs, and reveal boundaries | Omit card with diagnostic |
| `clocksConsequencesCard` | Utility, Reasoner at High/Ultra when healthy | Capture deadlines, countdowns, delayed consequences, and escalation triggers | Omit card with diagnostic |
| `environmentAffordancesCard` | Utility, Reasoner at Ultra when healthy | Capture spatial layout, sensory texture, hazards, obstacles, exits, and usable environmental affordances | Omit card with diagnostic |
| `possessionsItemsCard` | Utility, Reasoner at Ultra when healthy | Capture important held, carried, worn, hidden, lost, stolen, or controlled objects and who has them | Omit card with diagnostic |
| `openThreadsCard` | Utility, Reasoner at Ultra when healthy | Capture immediate unresolved pressures and promises visible in play | Omit card with diagnostic |
| `fusedCardBundle` | Utility by default, Reasoner when Fused routing selects it | Generate every requested card family together in one structured foreground bundle | Fused bundle validation reports accepted, invalid, rejected, omitted, and missing requested families. Runtime uses that structure to rerun only damaged or missing requested families when at least one fused item is trustworthy. |
| `rapidTurnDelta` | Utility | Select warm raw cards and write provider-authored turn guidance for the Rapid foreground path | Escalate to Standard only when a missing card is mandatory |
| `guidanceComposer` | Utility | Write provider-authored direction for using selected raw cards in the next generation | Fall back to raw-card-only packet when invalid or unavailable |
| `cardAuthoringAssist` | Utility | Rewrite a user draft or intent into a compact high-value Recursion card suggestion | Keep the user draft as local fallback and expose provider-fallback diagnostics |
| `generationReviewer` | Utility at Low/Medium; Reasoner at High/Ultra when healthy | General frozen-generation review contract; return bounded patches and per-installed-card outcome ledger | Parse/schema and semantic recovery share one correction budget. Apply only safe patches; unresolved outcome coverage is explicit `partial-failed`, while unsafe patches and unrecoverable fidelity defects fail or return `requires-regeneration`. |
| `editorialDiagnostician` | Utility at Low/Medium; Reasoner at High/Ultra when healthy | Propose a bounded diagnosis against frozen evidence; never return candidate prose | Runtime validates identity, shape, bounds, and request-known evidence IDs. Redirect citation authority and relevance remain semantic questions for the mandatory Verifier. |
| `editorialTransformer` | Repair/Recompose retain normal Enhancement routing. Redirect uses Utility at Low and Reasoner at Medium/High/Ultra. | Apply the Repair/Recompose brief or Redirect proposal as bounded patches or one complete candidate | Medium+ Redirect permits exactly two actual Reasoner writer calls, sends the first failure into the second correction prompt, and fails without Utility fallback when both attempts fail. Recursion pins source/snapshot/diagnosis identity from the frozen request; mechanical candidate safety passes before verification or host mutation. |
| `editorialVerifier` | Utility for Low Redirect; ready Reasoner for Medium/High/Ultra Redirect; Reasoner at High/Ultra for Recompose with ordinary Utility fallback | Judge the proposed Redirect diagnosis and produced candidate against complete frozen evidence, return binary accept/reject for Recompose, or audit Repair with dynamic `failedCardIds` | Medium+ Redirect is skipped before provider work unless Reasoner is ready. No rewrite, ranking, or alternate candidate. Repair audit IDs are validated against the frozen installed hand and canonical outcomes are built locally. A valid rejection preserves resolved rows and leaves only failed IDs unresolved. |
| `editorialEffectivenessJudge` | Utility, live evaluation harness only | Independently judge Redirect trajectory, forbidden beats, character pressure, and evidence/constraints | Never runs during normal chat generation; malformed, skipped, or incomplete judge output fails strict model evaluation. |
| `postProcessGuidanceUtility` | Utility at Low/Medium only | Analyze where and how the frozen ordered Post-process cards apply; return concise structured guidance, never revised story prose | One same-role Utility correction retry at most; invalid or unavailable guidance fails the operation/category without Reasoner fallback |
| `postProcessGuidanceReasoner` | Reasoner at High/Ultra only | Analyze where and how the frozen ordered Post-process cards apply; return concise structured guidance, never revised story prose | One same-role Reasoner correction retry at most; invalid or unavailable guidance fails the operation/category without Utility fallback |
| `reasonerComposer` | Reasoner | Fuse crowded or conflicted card hands into a compact instruction patch | Fall back to Utility guidance plus raw selected Card Evidence |
| `providerTest` | Selected lane | Validate lane connectivity and structured response capability at the configured max-token ceiling | Record hash-bound health only; never mutate provider configuration |

Card names should align with [Card System Spec](../design/CARD_SYSTEM_SPEC.md). Prompt installation and depth decisions belong to [Prompt Composition Spec](PROMPT_COMPOSITION_SPEC.md), not provider routing.

The literal `compose-brief` Arbiter action is retained as a V1 enum name, but it now means compose the V3 Guidance/Card Evidence/Guardrails packet. The router rejects undeclared role ids and requires each role to return its expected schema before reporting `ok: true`: Arbiter uses `recursion.utilityArbiter.v1`, card roles use `recursion.card.v1`, Fused card bundles use `recursion.cardBundle.v1`, Rapid foreground uses `recursion.rapidTurnDelta.v2`, Guidance Composer uses `recursion.guidanceComposer.v1`, Card Authoring Assist uses `recursion.cardAuthoringAssist.v1`, Generation Reviewer uses `recursion.generationReview.v1`, Editorial Diagnostician uses `recursion.editorialDiagnosis.v1`, Editorial Transformer uses `recursion.editorialPass.v1`, Editorial Verifier uses `recursion.editorialVerification.v1`, Editorial Effectiveness Judge uses `recursion.redirectEffectivenessJudge.v1`, Reasoner Composer uses `recursion.reasonerComposer.v1`, and Provider Test uses `recursion.providerTest.v1`. Editorial machine-JSON requests constrain selected mode, frozen identities, output shape, bounds, installed-card IDs, repair-target IDs, and citations to request-known evidence IDs. Repair and Recompose retain their narrower preservation-reference contract. Repair Transformer requests carry complete frozen target records, use a candidate-free bounded-patch envelope, and require at least one effective patch. Provider normalization derives known patch domains from the trusted target and recovers visibly swapped evidence/domain fields only when the displaced values are all request-known evidence IDs. Repair's initial diagnosis and Transformer calls disable provider-layer structured retry while preserving one runtime semantic-correction budget across primary and fallback calls. Redirect deliberately permits any request-known evidence ID in its citation fields: authority labels remain attached to the frozen evidence, but the mandatory Verifier model decides whether each diagnosis claim is actually grounded, whether source prose was mistaken for canon, and whether the proposed trajectory is feasible. Unknown Redirect bookkeeping references are dropped with path-specific private diagnostics and are never replaced with guessed evidence. Runtime constructs the private canonical `diagnosis.brief` after structural validation, then sends the complete proposal and any dropped-reference diagnostics to Transform and Verifier. Redirect transform remains flat and mode-specific: the provider returns only frozen identity and top-level `text`; runtime constructs bounded audit metadata mechanically. Because not every host provider enforces JSON Schema `const`, the provider boundary replaces Editorial identity echoes with trusted request values. Identity, known-ID provenance, output bounds, candidate difference, presentation envelope, source stability, and host mutation remain deterministic safety checks; editorial relevance and evidence support do not. Redirect always requires the production Verifier before host mutation. The normal path remains exactly three model calls. If the first valid verifier result rejects the first candidate and the writer budget remains, runtime sends that rejection into one corrected writer call and verifies the second candidate. A second valid rejection preserves the original. Diagnosis and Verifier retain the operation-scoped malformed-output recovery token. At Medium and above, Transform owns a literal two-call Reasoner writer budget: provider-internal retry is disabled for each call, and no Utility writer fallback is allowed. A provider/schema failure on the first writer consumes the same second-writer budget used by verifier-directed correction, so runtime never makes a third writer call. Consequently, a Redirect run is capped at five production model calls: one diagnosis, two writers, and two verifications. Recompose retains its source-relative candidate-length bound, while Redirect may rebuild a short failed source up to the shared absolute 16,000-character bound. Editorial roles inherit the selected Utility or Reasoner lane's configured max-token ceiling. The bounded transcript is exposed as `message:N` evidence alongside packet, card, brief, story-form, and source evidence.

Post-process Guidance Utility and Post-process Guidance Reasoner both use the
`recursion.postProcessGuidance.v1` response schema.

### Redirect contract

Redirect is a trajectory correction, not a stronger Recompose. A `proceed`
diagnosis requires `sourceFailure`, `replacementObjective`, non-empty
`requiredBeats`, non-empty `forbiddenSourceBeats`, `sceneCharacters`, and
`characterPressure`. Runtime requires usable bounded structure and request-known
citations but does not decide whether the diagnosis covered every character or
interpreted a want correctly. The mandatory Verifier judges those claims against
the complete frozen evidence. Pressure remains advisory: it can make a strong
response more likely, but never mechanically requires speech, action, or rising
pressure.

`sourcePressureEffect` should use `increasing`, `decreasing`, `unchanged`, or
`unclear`. A blank effect is incomplete advisory bookkeeping, not a terminal
diagnosis failure: runtime normalizes only that missing value to `unclear`,
records its exact `characterPressure[N].sourcePressureEffect` path, and passes
the diagnostic to the writer and mandatory Verifier. It preserves the
provider-authored immediate want, citations, and reason unchanged and does not
spend a correction call. Non-empty pressure claims remain model evidence for
the Verifier rather than a deterministic enum gate.

`proceed` is Redirect's only valid diagnosis decision. Editorial diagnosis uses
low reasoning intent from the first request to protect the structured response
budget. Provider-authored
`no-change` is a semantic contract failure and may receive one correction request.
If correction remains invalid, Redirect fails visibly and preserves the original;
it never reports a skipped success.

Required beats remain authoritative independently of pressure. When a validated
beat requires visible speech or action, the transformer and verifier cannot replace
it with passive attention, agreement, observation, or internal feeling.

The Redirect transformer returns top-level `text`; the provider boundary constructs
the canonical internal candidate and one evidence-backed `changeLedger` entry whose
`kind` is `redirect`. Every Redirect is independently
verified at every reasoning level. Cache identity and execution use the same
`editorialVerificationRequired()` result, so a direct or stale candidate cannot be
reused as verified. An accepted verifier result is bound to the candidate hash and
contains each of these checks exactly once:

The Redirect provider schema requires a non-empty `changeLedger` and constrains its
entries to `kind: "redirect"`; Recompose retains the broader change-kind enum.

- `diagnosis-evidence-grounded`
- `source-failure-removed`
- `replacement-objective-fulfilled`
- `required-beats-satisfied`
- `forbidden-source-beats-excluded`
- `character-pressure-coherent`
- `hard-constraints-preserved`
- `user-turn-answered`
- `unsupported-facts-absent`

The Redirect verifier request includes the complete proposed diagnosis, not only
its hash, so all nine checks are evaluated against frozen evidence, the replacement
objective, required and forbidden beats, and private character-pressure map. The
provider returns only `failedChecks` plus a short reason. The provider boundary
derives accept/reject and constructs all nine canonical evidence-bound check rows
locally. Unknown, duplicate, or malformed failed-check names remain invalid. The
hash still binds identity; it is not a substitute for the semantic input. Low
Low Redirect uses Utility for diagnosis, transformation, and verification. Medium,
High, and Ultra require Reasoner capability `ready` before host generation.
Diagnosis remains on its normal Utility-first policy; transformation and
verification remain on the exact armed Reasoner configuration with no Utility
fallback. Runtime revalidates that configuration before diagnosis and before
each mandatory Reasoner stage.

Missing, duplicate, failed, or unclear checks reject the candidate before host
mutation. Unknown diagnosis evidence references are surfaced privately to the
Verifier rather than deterministically deciding editorial support. Accepted Redirects always append/select one Recursion-owned
swipe and persist `sourceHash`, `candidateHash`, `verification: "accept"`, the
Redirect ledger, and private diagnosis evidence in that swipe marker. Cached reuse
requires that persisted accepted marker and performs no provider call. Visible UI,
assistant prose, prompt packets, and journal details expose no private character-want
or pressure text; journals retain only hashes, counts, status, and stable error codes.

`editorialEffectivenessJudge` exists only for dedicated live evaluation. It judges
the produced candidate independently on exact criteria `replacement-objective`,
`forbidden-source-beats`, `character-pressure`, and `evidence-and-constraints`.
Normal chat generation never invokes it.

`generationReviewer` first follows the global Structured Output Recovery contract. Its request carries the frozen source hash, eligible patch target IDs, and installed card IDs as structured fields so the provider machine schema can bind `sourceHash` and constrain patch, evidence, and outcome identifiers before semantic validation. Once its JSON and role schema pass, its role validator confirms the frozen source hash, exact eligible dialogue/prose target text, non-overlap, installed card IDs, outcome labels, and evidence target IDs. The active mode-specific Editorial path adds the Repair compact-audit contract: `editorialVerifier` returns only dynamic `failedCardIds`, and Recursion derives the complete canonical ledger and decision locally. Parser/schema correction, raw JSON reformat, and semantic review correction are mutually exclusive uses of one external correction request; Repair initial diagnosis/Transform calls preserve that budget by disabling provider-layer structured retry. A correction always preserves lane, provider source, model configuration, frozen snapshot, and pipeline provenance; raw provider text and hidden reasoning never reach review state, cache, journals, or UI details.

Card roles, `guidanceComposer`, `reasonerComposer`, and `rapidTurnDelta` receive the Arbiter-normalized `recursion.storyForm.v1` object as request context. Card roles must return instruction-shaped `promptText` in that form rather than narrative prose, mini-scenes, dialogue, sensory recap, or decorative narration. Guidance roles must align their prompt guidance to the same tense and point of view rather than deriving an independent form from the prompt.

When a `fusedCardBundle` provider call fails structured-output parsing but exposes visible response text, runtime may recover complete card objects from the `items` array prefix. Recovered fragments still pass the normal snapshot and per-card validation before use. Full Standard card fallback is reserved for zero trusted Fused cards.

## Utility Arbiter Call

The Utility Arbiter is the first model call when Recursion needs model help for a turn. Its job is to make the run plan, not to write prose.

Inputs:

- one immutable runtime snapshot;
- snapshot hash;
- current chat/message fingerprint;
- current settings hash;
- known scene cache metadata;
- available card types and token budgets;
- behavior influence policy for Strength, Focus, and Prompt Footprint;
- Reasoner on/off state and health summary.

The Arbiter should return every auto decision it can in the initial call. Recursion should not spend a separate model call just to decide whether to use Reasoner unless a later version has a concrete, measured reason to do so.

The Arbiter also owns story-form detection when the user has not forced a story form. It should infer the current tense and point of view from the latest visible assistant narration first, using the pending user message only when no assistant narration exists. This keeps card generation and prompt composition aligned with the host model's established output form. If the operator selects a Tense & PoV override, runtime bypasses Arbiter inference for the effective story form and uses a high-confidence `User override` story-form object instead.

Required output shape:

```json
{
  "schema": "recursion.utilityArbiter.v1",
  "snapshotHash": "string",
  "action": "skip | reuse-cache | refresh-cards | compose-brief",
  "sceneStatus": "same-scene | soft-shift | hard-shift | unknown",
  "promptFootprint": "compact | normal | rich",
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
  "storyForm": {
    "schema": "recursion.storyForm.v1",
    "tense": "past | present | mixed | unknown",
    "pov": "first-person | second-person | third-person-limited | third-person-omniscient | mixed | unknown",
    "confidence": "high | medium | low",
    "evidenceRefs": ["message:8"],
    "reason": "Latest assistant narration uses past tense third-person-limited prose."
  },
  "diagnostics": ["string"]
}
```

The Utility Arbiter must echo the frozen request `snapshotHash`. Missing or mismatched Arbiter hashes are stale output; runtime rejects the plan and uses the conservative local fallback instead of trusting its action, card jobs, lifecycle, diagnostics, or Reasoner decision.

The provider router only receives card jobs that can fit the effective hand budget. The Arbiter is instructed not to emit more `cardJobs` than `budgets.maxCards`, but runtime enforces this mechanically before provider calls because provider calls are the expensive boundary.

Invalid or unsupported `storyForm` values normalize to `unknown` rather than failing the whole plan. Runtime also runs a heuristic cross-check against the latest assistant narration. If obvious tense cues disagree with a confident Arbiter result, runtime lowers story form to `unknown` and records the disagreement reason. If stable-tense assistant narration has strong mixed POV evidence, runtime preserves that as mixed POV even when the Arbiter chose a single viewpoint family. Unknown story form produces conservative downstream prompt text that tells card and story models to match the active chat's established form.

The Arbiter is allowed to choose `reasonerDecision.mode: "use"` only when the
shared resolver reports Reasoner `ready`. For `unconfigured`, `untested`, or
`unhealthy`, runtime normalizes the decision to `skip` and records a compact
capability reason.

`promptFootprint` is a current-turn override only. Runtime accepts only `compact`, `normal`, or `rich`; invalid or missing values fall back to the stored user setting and must not appear in the sanitized plan. The override is passed to Prompt Composition for the packet being installed, but it does not mutate the stored setting.

## Batched Card Calls

Utility card calls should run from one snapshot. The batch boundary is part of the correctness contract: all card jobs in a run must see the same chat state, settings hash, scene cache metadata, and prompt budget.

The preferred execution shape is:

1. Runtime freezes a `snapshotHash` before asking the Arbiter.
2. Arbiter returns a plan that echoes the same `snapshotHash`.
3. Runtime rejects missing or mismatched Arbiter hashes before trusting `cardJobs`.
4. Utility card jobs are submitted as one batch when the host/provider supports batching.
5. If batching is unavailable, jobs may run sequentially, but they must still use the same frozen snapshot and shared run id.
6. Each card returns structured JSON with its own schema id, frozen snapshot hash, and compact evidence references.
7. Runtime validates and accepts, repairs locally where safe, or omits each card independently.

Card calls must not depend on sibling card outputs from the same batch. Fusion happens later in the Guidance composer or Reasoner composer.

Common card output envelope:

```json
{
  "schema": "recursion.card.v1",
  "role": "sceneFrameCard",
  "family": "Scene Frame",
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

Cards should be concise, observable, and player-message-adjacent. Provider cards are omitted independently when the envelope role/family does not match the requested catalog slot, the envelope `snapshotHash` is missing or does not match the frozen request hash, the card lacks parseable `message:N` evidence, or prompt-facing text contains hidden-reasoning wording. They must not include hidden character thoughts, private chain-of-thought, or broad plot plans.

Manual forced selection does not create a new provider schema. Runtime still sends one request per selected or Arbiter-requested family and expects the same `recursion.card.v1` envelope with one prompt-facing item for that family. If Manual selected a family that the Arbiter omitted, runtime synthesizes the missing `cardJob` after scope filtering with `forcedBy: "manual-selection"`; the provider is not asked to generate multiple families in one response.

## Cached Card Freshness

Scene cache entries may be shown to the Utility Arbiter as compact metadata so it can decide whether to reuse, stow, discard, or regenerate cards. Runtime must not treat that Arbiter visibility as permission to inject cached cards.

Before any cached card can enter the deck/hand for prompt composition, runtime must verify source freshness against the current normalized snapshot:

- source chat id matches the current chat when present;
- source message range is valid, visible, and not ahead of the current turn;
- at least one parseable `message:N` evidence ref exists, and all `message:N` evidence refs still point at visible messages inside that source range;
- expiry metadata has not passed;
- stored source fingerprint matches the current source-window fingerprint.

Cards that fail this check are stale cache artifacts. They may be counted in visible cache-inspection metadata, but their `promptText`, summaries, and evidence must not become prompt-facing. Routine cache inspection is not a warning by itself. If the Arbiter requests `reuse-cache` and no cached cards pass freshness, runtime should fail soft as cache unavailable instead of injecting stale guidance.

## Reasoner Composer Call

The Reasoner Composer receives accepted Utility cards, budget metadata, conflict markers, and the same snapshot hash. It returns a compact instruction patch for prompt composition. Runtime rejects missing or mismatched `snapshotHash` values as stale composer output and falls back to Utility guidance plus raw selected card evidence.

Reasoner is appropriate when:

- accepted cards exceed the normal prompt budget;
- Utility cards conflict or overlap in a way bounded runtime validation cannot cleanly resolve;
- multiple active characters have tense or subtle visible posture that needs careful fusion;
- the Arbiter selected Reasoner in its initial response and the shared resolver reports it `ready`.

Reasoner is not appropriate when:

- the hand is small and non-conflicting;
- Utility produced invalid or insufficient card data;
- Reasoning Level policy selects Utility;
- Reasoner capability is `unconfigured`, `untested`, or `unhealthy`.

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
      "basis": ["message:42", "card:scene-constraints-1"]
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
5. Reasoner runs only if the Arbiter selected it, the shared resolver reports it `ready`, and accepted card data is sufficient.
6. Prompt composition installs the Utility-only or Reasoner-assisted packet.

Auto must be Utility-first. A ready Reasoner is eligible under the selected
Reasoning Level; readiness must not cause every run to use Reasoner.

Advanced job routing may expose `Auto Route`, `Utility Provider`, and `Reasoner Provider` for internal roles, but v1 should keep that surface secondary to the main Utility and Reasoner provider cards.

## First Working Loop Contract

The first end-to-end loop should prove both composer paths even if the default setting is Utility-only:

1. Capture a stable snapshot.
2. Run Utility Arbiter or use a fake Arbiter fixture in tests.
3. Generate or reuse a small accepted hand.
4. Compose a prompt packet through `guidanceComposer`, injecting guidance plus full raw selected card evidence.
5. Compose through `reasonerComposer` when the setting and Arbiter decision permit it.
6. Keep Utility guidance plus raw selected Card Evidence if Reasoner is not ready, fails, times out, or returns invalid schema.
7. Install, skip, or clear the Recursion prompt packet through the host adapter.
8. Emit visible progress stages and sanitized model-call journal entries for the route taken.

Reasoner must not become mandatory for normal operation. The Utility path must remain good enough to ship as the default path.

## Structured Output and Validation

All provider-owned Recursion jobs must request structured JSON and validate before use.

Machine-JSON requests carry the expected `responseSchema` and, when available, the frozen `snapshotHash` into provider adapters. OpenAI-compatible calls should use schema-constrained JSON when supported, and SillyTavern connection-profile calls should pass equivalent `json_schema` metadata while disabling host preset/instruct injection for machine output. Prompt text and correction retries still spell out the required `schema` and `snapshotHash` fields because provider-side schema support is not universal.

Reasoning intent metadata may accompany machine-JSON requests. It is limited to compact fields such as `reasoningIntent`, `reasoningCategory`, `reasoningDialect`, `reasoningApplied`, and `reasoningDowngraded`; it must not include raw chain-of-thought or hidden reasoning text.

Validation requirements:

- normalize provider-shaped responses before parsing so empty visible output, reasoning-only output, and token-limit truncation become stable provider failures instead of ambiguous JSON parse failures;
- parse JSON through the shared structured-output parser, including safe recovery from fenced JSON, wrapper prose, `<think>` / `<reasoning>` blocks, comments, trailing commas, smart quotes, BOMs, literal line breaks inside strings, and a pinned local `jsonrepair` pass for complete object-shaped candidates;
- treat syntax repair as syntax repair only: never fabricate missing `schema`, `snapshotHash`, role, family, evidence, card text, budgets, diagnostics, or composer fields;
- verify `schema`, `role`, `snapshotHash`, enum values, string lengths, numeric ranges, and required arrays;
- reject outputs that include raw hidden reasoning, chain-of-thought, private motives, or unsupported durable lore;
- reject outputs that cite evidence outside the frozen snapshot;
- clamp confidence and token estimates to valid ranges;
- mark each accepted card or composer patch with schema version and source role.

Repaired output remains untrusted until all role-specific validation passes. Local repair runs only after strict/common parsing fails and only for candidates with complete object boundaries; it does not turn truncated Fused prefixes into synthetic complete bundles. A repaired Arbiter object missing or mismatching the frozen `snapshotHash` still falls back to the conservative local plan. A repaired card object with a missing or mismatched role, family, `snapshotHash`, or evidence range is omitted independently. Success diagnostics may record compact metadata such as `structuredOutputRepaired`, `structuredOutputRepairCode`, `structuredOutputRecovery: "local-json-repair"`, `originalResponseHash`, `repairedResponseHash`, and `visibleContentLength`; diagnostics, journals, activity, and artifacts must not persist raw malformed provider text or hidden reasoning.

`providerTest` is a connectivity and structured-output probe, not a content job. It passes only when the router succeeds and the parsed payload contains `schema: "recursion.providerTest.v1"` plus explicit `ok: true`; missing or false `ok` fails the lane test.

Invalid Utility Arbiter output should fall back to conservative local behavior: reuse valid cache, use the local fallback plan when safe, or skip Recursion injection for the turn. A missing, timed-out, or transport-failing Utility provider should not create fresh local cards; it should reuse valid cache or skip.

Invalid card output should omit only that card. One bad card must not poison the whole batch.

Invalid Reasoner output should fall back to Utility guidance plus raw selected Card Evidence.

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

Successful calls with a nonzero retry count are success-with-caution for visible progress. Runtime may accept their data, but the progress row should remain amber with compact `retried` meta and a sanitized reason instead of turning green.

Normalized provider error codes include:

- `RECURSION_PROVIDER_EMPTY_RESPONSE`: the provider returned no visible content.
- `RECURSION_PROVIDER_REASONING_ONLY`: the provider returned hidden reasoning without visible JSON content.
- `RECURSION_PROVIDER_TOKEN_LIMIT`: the provider stopped at a token limit before returning complete visible JSON.

Machine-JSON token exhaustion receives at most one compact structured recovery.
Sanitized failure diagnostics retain the provider model, effective output ceiling,
finish reason, token usage, visible response size, retry count, and recovery kind
when the provider supplies them. They never retain provider text or reasoning.

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

- retry the same Utility call once only for transient transport failures or timeout classes when the runtime still owns the current snapshot;
- do not block normal SillyTavern generation;
- reuse a still-valid installed prompt packet only if its snapshot/settings hashes match;
- otherwise clear or skip Recursion injection for the turn;
- record a sanitized journal entry and visible lane status.

Card failure:

- accept valid sibling cards;
- treat malformed or missing-role batch entries as failed slots before provider dispatch;
- omit failed cards with omission reasons;
- continue composition if enough accepted cards remain.

Reasoner failure:

- retry the same Reasoner call once only for transient transport failures or timeout classes when the runtime still owns the current snapshot and the current configuration hash remains eligible;
- fall back to Utility guidance plus raw selected Card Evidence;
- do not run an additional hidden Utility model call solely to recover the Reasoner result; use the Guidance composer output that is already part of the normal route, or compose locally from accepted cards if available;
- record a compact reason such as auth failure, timeout, validation failure, or provider error.

OpenAI-compatible authentication failure:

- mark the lane unhealthy for the current session;
- preserve non-secret settings;
- keep the API key out of error messages;
- require the user to re-enter or clear the session key before another direct-endpoint test.

Timeouts and aborts:

- provider calls must receive an abort signal from the runtime;
- user disable, chat change, settings change, and host generation stop should abort in-flight Recursion calls when their output would be stale;
- aborted calls should not install prompt packets;
- player Stop / `GENERATION_STOPPED` should settle Recursion progress as skipped instead of provider warning or failure.

## Retry and Fallback Policy

Recursion should borrow Directive's robustness discipline in smaller form:

- every provider call has a role, lane, timeout, run id, snapshot hash, and abort signal;
- every result is normalized into success, validation failure, provider failure, timeout, abort, or stale result;
- default provider timeout is 120 seconds unless a caller overrides it;
- transient transport failures may get one same-lane retry only while the abort signal is still open and the current-run or current-snapshot guard passes; classification walks bounded nested `cause` chains because SillyTavern connection profiles wrap upstream failures in a generic `API request failed` error;
- schema failures do not get blind retries unless the failure is clearly recoverable, such as schema mismatch or likely truncation; correction prompts must restate the required response `schema` and frozen `snapshotHash` when present;
- card failures, including malformed batch entries, omit only the failed card and keep valid siblings;
- Utility Arbiter failure reuses valid cache or skips injection;
- Reasoner failure falls back to Utility guidance plus raw selected card evidence;
- all fallbacks emit progress status and sanitized journal events.

The retry policy should be conservative. Reattempts are for resilience, not for chasing better creative output.

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
