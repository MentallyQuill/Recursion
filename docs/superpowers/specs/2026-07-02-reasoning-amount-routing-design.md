# Reasoning Amount Routing Design

## Goal

Recursion Reasoning Level must control both which lane is used and how much reasoning the selected provider is asked to spend. The implementation should support direct OpenAI-compatible endpoints and SillyTavern host routes without adding a new user-facing setting.

## Current Gap

`reasoningLevel` currently changes lane routing and card pressure, but provider requests do not carry a normalized reasoning amount. A Reasoner provider such as GLM-5.2 can therefore remain at the endpoint default, including `Reasoning: minimal`, even when Recursion is set to High or Ultra.

## Strategy

Add a normalized `reasoningIntent` to provider requests. Runtime and prompt composition decide the intent from the user-selected Reasoning Level and the role being run. Provider adapters translate that intent to each supported API dialect when the route supports it.

The UI stays unchanged. `reasoningLevel` remains the authoritative user-facing control.

## Intent Matrix

| Call category | Low | Medium | High | Ultra |
| --- | --- | --- | --- | --- |
| Final brief / pre-conditioning | minimal | medium | medium | high |
| Reasoner Arbiter | minimal | minimal | medium | medium |
| Reasoner card calls | minimal | minimal | minimal | medium |
| Provider tests and structured-output retries | minimal | minimal | minimal | minimal |

Utility-lane calls may carry `minimal` only when doing so is safe. Reasoner-lane calls should always carry an intent so live diagnostics can prove Recursion attempted the requested depth.

## Provider Dialects

Direct OpenAI-compatible endpoint translation:

- OpenRouter and OpenAI-style gateways: `reasoning: { effort: "<intent>", exclude: true }`.
- Z.AI / GLM-5.2: `thinking: { type: "enabled" }` plus `reasoning_effort`.
- MiniMax-M3: `thinking: "adaptive"` for minimal/medium and `thinking: "enabled"` for high.
- DeepSeek reasoner: no invented effort field. Its practical control is model choice plus `max_tokens`, so Recursion records the intent but does not send unsupported fields.
- Unknown endpoint: do not send speculative reasoning fields. If a known dialect request fails with an unknown-parameter style HTTP error, retry once without reasoning fields and mark the sanitized diagnostics as downgraded.

Host route translation:

- `host-current-model` sends `reasoningIntent` through the raw generation request object.
- `host-connection-profile` sends `reasoning` metadata through the parameter object passed to `ConnectionManagerRequestService.sendRequest`.
- Hosts may ignore unsupported fields. Recursion still records the normalized request intent.

## Privacy And Diagnostics

Reasoning output remains private. Recursion must not expose, persist, or inject raw provider reasoning, thought summaries, `reasoning_content`, or thought blocks.

Sanitized diagnostics may include:

```json
{
  "reasoningIntent": "medium",
  "reasoningDialect": "openrouter",
  "reasoningApplied": true,
  "reasoningDowngraded": false
}
```

## Files

- `src/providers.mjs`: normalized intent helpers, direct endpoint dialect translation, retry-without-reasoning downgrade, sanitized diagnostics.
- `src/runtime.mjs`: Arbiter and card call categories.
- `src/prompt.mjs`: final brief/pre-conditioning category for `reasonerComposer`.
- `src/hosts/sillytavern/host.mjs`: host current-model and connection-profile pass-through.
- `tools/scripts/test-providers.mjs`: direct endpoint dialect and diagnostics coverage.
- `tools/scripts/test-runtime.mjs`: Reasoning Level to request intent coverage.
- `tools/scripts/test-host.mjs`: SillyTavern host pass-through coverage.
- Provider and routing docs: document the intent matrix and privacy boundary.

## Verification

Focused verification:

```powershell
npm.cmd run test:providers
npm.cmd run test:host
npm.cmd run test:runtime
```

Full deterministic verification:

```powershell
npm.cmd test
```

Live verification:

- Use a dedicated `recursion-soak-*` user.
- Ensure the live SillyTavern extension copy serves the updated files.
- Use Playwright to run a Reasoner-enabled pass and inspect sanitized request evidence showing High or Ultra selected a stronger reasoning intent for the final brief.
