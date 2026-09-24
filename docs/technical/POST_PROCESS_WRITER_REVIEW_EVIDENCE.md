# Post-process writer and review verification

The feature was implemented on `codex/post-process-writer` in an isolated managed
worktree and integrated with main through `c5c99a56`. The original checkout and
its unrelated uncommitted changes were not modified.

## Verification boundaries

The checks use production modules with deterministic provider responses and
isolated chat/storage fixtures. They do not certify prose quality or live remote
provider availability. Installed SillyTavern source was inspected for Connection
Manager formatting, saved preset fields, native backend limits, and deletion event
payloads. No running user host settings, provider credentials, or chats were changed.

Text-completion profiles use a conservative input-capacity check on the complete
formatted prompt: UTF-8 bytes plus output tokens and a framing reserve. This can
reject input that a model-specific tokenizer could fit; it never shortens the
mandatory draft to make a request fit. See `../user/PROVIDER_SETUP.md`.

## Final merged gates

- `npm.cmd test`: PASS, 99 offline test scripts.
- `npm.cmd run test:browser`: PASS, 4 browser/isolated-host test scripts.
- `git diff origin/main --check`: PASS.
- Targeted re-review of transport and cancellation fixes: clean.

## Requirement evidence

| Requirement | Evidence |
| --- | --- |
| Writer/settings/deck contracts | `test-settings`, `test-post-process-decks`, `test-post-process-editing`: validation, limits, copy, style import/export, sparse default behavior. |
| Scope, evidence, full draft | `test-post-process-guidance`, `test-post-process-runtime`: explicit scope precedence, sample isolation, complete draft, bounded complete evidence fields with omission notices. |
| Separate profile prose transport | `test-post-process-profile-writer`: selected model/profile, request-local sampling and secret references, no schema/JSON repair, active backend independence, native output/context aliases, conservative input fit. |
| Native regression/failure/Stop | `test-post-process-host-writer`, `test-post-process-runtime`: native quiet writer, errors, no-op, truncation, cancellation, late completion. |
| Frozen Unified/Progressive execution | Runtime and review-runtime tests cover frozen options, profile provenance, stage reuse, and Progressive guidance keyed to the actual preceding draft. |
| Durable pending review | `test-post-process-review-runtime`: pending review survives runtime recreation, does not apply until accepted, releases running state. |
| Guarded actions and crash recovery | `test-post-process-review`, `test-post-process-host-restore`, review-runtime: serialized acceptance, lost commit/restore settlement, original/current-target separation, immutable-original retry, editing, and restoration. |
| Cleanup/storage/privacy | `test-post-process-comparison`, `test-runtime-post-process-review`, `test-extension-post-process-review`, existing storage/privacy tests: ten completed records, protected pending, 8 MiB cap, verified writes, corrupt-body repair, reset/deletion guards, stale evidence release. |
| UI and accessibility | `test-ui-post-process-review-browser`: desktop/mobile, selectors, externally changed profile lists, preserved unsaved style, diff/clean text, inert HTML, manual editing, retry, focus/scroll, stale actions. |
| Production host integration | Same browser script joins production UI, root runtime, repository and SillyTavern adapter: pending reload, guarded apply, retry original, manual edit/accept, Keep Original selecting an existing swipe. Separate host tests cover Replace and profile request payloads. |
| Final gates/review | Full merged offline and browser gates; independent transport, runtime/storage and UI integration reviews. Material findings received regression tests before fixes. |

## Review fixes

- Preserve scheduler cancellation through comparison persistence and final host commit.
- Store a fresh retry candidate even when the writer returns the original text.
- Enforce Ollama/llama.cpp output limits and saved text context limits using native fields.
- Project saved text samplers independently of the active host backend.
- Refresh externally changed profile lists and preserve unsaved style across panel renders.

Sanitized screenshots and machine-readable browser reports are generated locally in
`artifacts/post-process-writer-review/`; generated artifacts are not committed.
