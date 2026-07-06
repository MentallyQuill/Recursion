# Injection Placement Live Proof Design

## Goal

Prove that Recursion supports both SillyTavern injection placements and that the user-selected placement, role, and depth reach the host prompt store and the actual generation payload.

## Contract

- `in_prompt` installs each Recursion block with SillyTavern position `0`.
- `in_chat` installs each Recursion block with SillyTavern position `1`.
- The selected role and depth remain unchanged in the inspected host prompt store.
- With role `system`, Guidance, Card Evidence, and Guardrails must serialize only into `system` messages in the outbound `/api/backends/chat-completions/generate` request.
- Live proof covers Standard, Rapid, and Fused under both placements.

## Implementation

Extend the existing live pipeline proof rather than create a second browser harness. Add placement CLI parsing, force the requested injection settings through the live runtime, inspect the live `extensionPrompts` entries after installation, and correlate that evidence with request interception. Each proof row reports pipeline, requested placement, configured depth/role, stored numeric metadata, and sanitized outbound message evidence.

## Failure Handling

The proof fails closed when placement is invalid, runtime settings do not settle, any stored block has the wrong position/depth/role, any block is missing, or outbound Recursion content is absent from `system` messages.

## Verification

Use TDD for argument parsing and stored-prompt validation. Run focused harness tests, then execute the six-case live matrix against the dedicated SillyTavern soak user.
