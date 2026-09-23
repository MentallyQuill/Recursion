# Provider Setup

Recursion uses SillyTavern Connection Profiles for all Utility and Reasoner model work. It does not contain a separate endpoint or credential setup surface.

## Before Opening Recursion

Create one or two Connection Profiles in SillyTavern:

- one profile can serve both Utility and Reasoner;
- separate profiles can use different models or generation presets;
- text-completion profiles should have the intended instruct template selected;
- sampler values should be stored in the profile generation preset when you want Recursion to inherit them.

SillyTavern owns provider routing, model selection, endpoint configuration, credentials, generation presets, and instruct presets. Recursion stores only the selected profile id and its own policy choices.

## Recommended Setup

Apply these settings to each Recursion lane:

1. Select a SillyTavern Connection Profile.
2. Keep `Behavioral Preset` on `Isolated` unless the complete profile preset is intentionally trusted for structured analysis calls.
3. Keep `Instruct Formatting` on `Auto` for text-completion compatibility.
4. Keep `Samplers` on `Connection Profile` to inherit sampler tuning without importing prompt fields.
5. Keep `Structured Output` on `Auto` so certification can choose native schema or prompt-only JSON.
6. Leave the output-token ceiling at its default until a specific model requires a lower hard cap.
7. Run `Test Profile`.

These defaults solve two different problems independently: behavioral preset isolation protects structured output, while instruct formatting and sampler inheritance keep local text-completion models usable.

## Utility And Reasoner

| Lane | Required | Typical work |
| --- | --- | --- |
| Utility | Yes | Arbiter, ordinary cards, validation support, normal guidance, and fallback. |
| Reasoner | No | Policy-selected synthesis, high-priority cards, Fused bundles, and difficult editorial work. |

Reasoning Level controls broad lane preference:

- Low: Utility-only.
- Medium: Utility planning/cards, Reasoner guidance when eligible.
- High: Reasoner planning and priority work when eligible.
- Ultra: Reasoner-heavy routing when eligible.

Ordinary Pre-process work falls back to Utility if Reasoner is unavailable. Post-process operations that explicitly require Reasoner remain lane-sticky and fail soft rather than silently switching models.

## Generation Policy Controls

### Behavioral Preset

`Isolated` excludes the selected profile's complete generation preset from Recursion prompts. This is the default and safest mode for JSON-oriented work.

`Full Profile` imports the complete preset. Use it only when the preset is known not to add roleplay instructions, prose requirements, wrappers, or other behavior that conflicts with structured output.

### Instruct Formatting

`Auto` enables instruct formatting for text-completion profiles and disables it for chat-completion profiles.

Use `On` only when a profile requires instruct framing despite incomplete completion-mode metadata. Use `Off` only when the backend or preset already performs framing and a second template would be harmful.

### Samplers

`Connection Profile` materializes the selected generation preset through SillyTavern and copies only safe sampler controls. Prompt/messages, model routing, stop strings, token limits, reasoning fields, endpoint data, and credentials are excluded.

`Recursion Override` uses the lane's Temperature and Top P controls. These controls appear only in override mode.

If profile sampler projection fails, Recursion falls back to its Temperature and Top P values and records a fixed diagnostic code. It does not import the complete preset as a fallback.

### Structured Output

`Auto` uses the method established by current profile certification.

- Native schema is used only when the profile has demonstrated support.
- Prompt JSON is used when native schema is unavailable or rejected.

The explicit modes exist for diagnosis. `Auto` is the normal operator choice.

## Test Profile

`Test Profile` is staged certification, not a simple connectivity ping.

1. Connectivity check: a small JSON object.
2. Single-card check: the compact card contract used by Segmented.
3. Fused check: a representative two-family bundle.

The provider header displays one capability:

| Label | Meaning |
| --- | --- |
| Configure | No selected available profile. |
| Untested | Profile is configured but has no current certification. |
| Segmented | Connectivity and single-card checks passed. |
| Fused | All three checks passed. |
| Issue | Connectivity or single-card compatibility failed. |

A partial certification is useful: a model may be reliable for Segmented even when it cannot return a valid Fused bundle.

Profile certification is bound to the selected profile and generation policy. Changing the profile, preset policy, instruct policy, sampler policy, structured-output policy, sampler overrides, or output ceiling invalidates the previous result.

## Pipeline Eligibility

Segmented makes one narrow card request per unresolved family. Requests are logically independent but physically serialized when they share a Connection Profile.

Fused asks one model call for the requested card bundle. Explicit Fused selection dispatches it without requiring a profile test.

Certification remains diagnostic. Missing profile configuration produces an actionable configuration error; untested, partial, or failed certification does not silently switch the selected pipeline.

When a Fused response contains some valid items:

- valid requested families are retained;
- only unresolved families receive Segmented repair calls;
- accepted Fused cards are not regenerated.

When no useful item survives, the Fused attempt window settles once and Recursion starts the complete Segmented card path.

## Local Model Traffic

Every Connection Profile has a FIFO request queue with concurrency one.

- Ten Segmented card stages using one profile produce one physical model request at a time.
- Utility and Reasoner may overlap only when they select different profiles.
- Stop removes queued requests before they start and aborts the active request where supported.

This protects local backends from request bursts while preserving durable stage checkpoints.

## Output Budgets

The lane Output Token Ceiling is the default maximum output allowance for production requests, including planning, individual cards, fused bundles, and guidance. A value of 16000 sends a 16000-token allowance unless the caller explicitly requests less. It is an allowance, not a target response length. Connectivity certification remains a small 128-token probe. Utility requests default to minimal reasoning; Reasoner requests follow the selected reasoning policy.

A context-limit retry lowers only the stage output budget. It does not change the profile, samplers, or prompt policy at the same time.

## Common Failures

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Configure | No profile selected, profile deleted, or profile unsupported. | Repair or select the profile in SillyTavern, then reopen Recursion settings. |
| Untested | Profile or policy changed after the last test. | Run Test Profile. Segmented can still run with a visible caution. |
| Issue after connectivity | Connection/profile failure or invalid small JSON. | Test the profile directly in SillyTavern and verify its instruct/preset configuration. |
| Segmented but not Fused | Single-card contract passes; bundle contract does not. | Keep Segmented, or tune the profile/model and retest. |
| Text model emits wrappers or roleplay prose | Instruct template missing or behavioral preset contaminating the request. | Use Instruct Auto and Behavioral Preset Isolated. |
| Samplers appear ignored | Profile preset materialization unavailable or unsupported field name. | Inspect sanitized diagnostics for `profile-sampler-projection-failed`; use Recursion Override if needed. |
| Context-limit failures | Output ceiling or prompt footprint is too large for the model context. | Reduce the lane ceiling or prompt footprint; stage retries already reduce output allowance within safe floors. |
| Requests stall behind each other | Same profile selected for multiple active stages. | This is expected serialization. Use different profiles only when the backend can safely serve them concurrently. |
| Fused selection runs Segmented | Profile is not Fused-certified. | Run Test Profile and inspect whether the Fused check passes. |

## Privacy And Security

Recursion stores no endpoint or credential for model access. Diagnostics and checkpoints must not contain:

- Connection Profile ids;
- endpoint or server addresses;
- credentials, cookies, or authorization headers;
- raw Recursion prompts;
- raw model output;
- hidden reasoning;
- full transcript text;
- stack traces.

The Connection Manager request uses `extractData: false`; structured recovery remains inside Recursion. Only fixed codes, capability state, effective policy, bounded token/finish metadata, and attempt actions are retained.

## Verification Checklist

Before relying on a profile:

1. Confirm the Connection Profile works in SillyTavern.
2. Select it for Utility.
3. Keep Isolated, Auto instruct, Connection Profile samplers, and Auto structured output.
4. Run Test Profile.
5. Confirm the lane reports Segmented or Fused.
6. Run a Segmented turn and verify one physical request at a time for the profile.
7. Try Fused only after the lane reports Fused.
8. Press Stop during a queued multi-card run and verify queued calls do not start.
9. Export diagnostics and confirm they contain no prompt, output, profile id, endpoint, credential, or hidden reasoning.

Related documents:

- [First Run Workflow](FIRST_RUN_WORKFLOW.md)
- [Operator Manual](RECURSION_OPERATOR_MANUAL.md)
- [Prompt Privacy And Safety](PROMPT_PRIVACY_AND_SAFETY.md)
- [Provider And Generation Spec](../architecture/PROVIDER_AND_GENERATION_SPEC.md)
