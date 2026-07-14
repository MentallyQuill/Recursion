# Provider Failure Status Design

## Goal

Surface actionable model-call failures in Recursion's compact status bar and progress tree without exposing raw provider payloads, credentials, prompts, or unbounded error text.

## Contract

The provider boundary owns failure classification. A failed provider result and its corresponding activity event carry:

- `failureKind`: a stable machine category.
- `failureLabel`: concise, sanitized user-facing text.
- Existing diagnostic `code`, `status`, and sanitized `message` fields for journals and progress detail.

The initial failure categories and labels are:

| Kind | Status label |
| --- | --- |
| `insufficient-funds` | `Insufficient funds.` |
| `context-length` | `Context length exceeded.` |
| `output-limit` | `Model response hit its output limit.` |
| `rate-limit` | `Model rate limited.` |
| `authentication` | `Model authentication failed.` |
| `permission` | `Model access denied.` |
| `model-not-found` | `Configured model is unavailable.` |
| `timeout` | `Model call timed out.` |
| `network` | `Model connection failed.` |
| `service-unavailable` | `Model service unavailable.` |
| `invalid-response` | `Invalid model response.` |
| `content-rejected` | `Model request was rejected.` |
| `unknown` | `Model call failed.` |

Classification inspects the complete wrapped error chain, structured error codes, HTTP status, and known provider messages. Structured codes and statuses take precedence over message matching. Raw provider text is never used directly as compact UI copy.

## Status Bar

While work is running, the existing active-step text remains authoritative. Once a run settles with a provider failure and no work remains active, the compact bar displays the most recent failed model-call label with its lane when known:

- `Utility model: Insufficient funds.`
- `Reasoner model: Context length exceeded.`

The generic `Needs attention.` remains the fallback for non-provider warnings and failures. The progress tree retains the failed step and displays the same concise failure label as its reason.

## Retry Policy

The classifier also supplies retryability. Rate limits, timeouts, network failures, and server-unavailable responses remain retryable. Insufficient funds, context-length overflow, authentication, permission, missing-model, content rejection, and invalid-request failures are non-retryable. Output truncation continues through the existing structured-output recovery policy rather than generic transport retry.

## Safety

Labels come only from the fixed category table. Journals may retain the existing bounded, scrubbed diagnostics, but compact UI fields cannot contain request text, response text, API keys, authorization values, cookies, credentials, or provider-specific free-form payloads.

## Tests

Provider tests cover nested wrapped errors, structured codes, HTTP statuses, message variants, retryability, output-limit distinction, and secret-safe fallback behavior. Progress and UI tests prove that the classified label reaches both the failed tree row and terminal compact status text, while active work and non-provider failures retain their existing behavior.

The full repository test command remains `npm.cmd test`.
