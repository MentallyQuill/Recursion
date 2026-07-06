# SillyTavern Prompt Enum Boundary Fix

## Problem

Recursion's SillyTavern adapter reads `setExtensionPrompt` from `SillyTavern.getContext()`, but the live context does not expose `extension_prompt_types` or `extension_prompt_roles`. The adapter's string fallbacks therefore reach SillyTavern's numeric coercion as `NaN`. The setter does not throw, so Recursion records a false successful install, while SillyTavern excludes the entries from the final request.

## Design

Keep the host adapter independent of SillyTavern module paths. Define the documented numeric prompt type and role values as adapter fallbacks, while continuing to honor numeric enums supplied by an injected test or future host context.

After each write, when the live context exposes the shared `extensionPrompts` store, verify that the stored entry contains the requested text and finite numeric position and role. A rejected or malformed stored entry makes installation fail and triggers the existing rollback path. Contexts without an inspectable store retain setter-based behavior for host-adapter isolation tests.

## Regression Coverage

- Reproduce the real `getContext()` shape: setter and prompt store present, enum maps absent.
- Model SillyTavern's numeric coercion and final prompt-position filter.
- Assert that all three Recursion blocks survive with numeric placement and role values.
- Assert that a setter producing malformed stored metadata fails installation rather than journaling a false success.
- Update live proof to validate stored numeric metadata and final serialized request content, not only setter calls.

## Success Criteria

The focused test must fail before the adapter change, pass afterward, and the final SillyTavern chat-completion payload must contain Guidance, Card Evidence, and Guardrails content for an actual generation.
