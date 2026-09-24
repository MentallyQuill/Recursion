# Post-process Cards Runtime Boundary

**Status:** Current implementation contract; verification evidence is recorded separately.
**Approved design:** [Post-process Writer and Revision Review](../superpowers/specs/2026-09-23-post-process-writer-review-design.md)

Post-process Cards are independent from the Pre-process evidence deck. They edit a completed assistant response; they do not continue the story or replace the primary generation route. This contract supersedes the earlier native-only writer and final-draft-only retention descriptions.

## Frozen evidence and guidance

An operation captures chat, message, selected swipe, source hash, active character/group, originating turn, complete original draft, ordered runnable cards, scope, style, writer configuration, and supporting evidence. Evidence includes the latest user message, selected recent visible messages, character context, applicable Pre-process packet, and story form.

`postProcess.contextMessages` defaults to 13 and ranges from 0 to 35. It bounds Recursion's evidence window. A profile writer receives this editing context; a native writer also retains native host context. Supporting evidence is budgeted as complete fields/messages with omission metadata. Never shorten the writable draft or slice a serialized JSON document to fit.

Utility synthesizes guidance at Low/Medium; Reasoner does so at High/Ultra. This lane remains fixed for the operation. Guidance returns exactly `{ "guidanceText": "..." }`, with a nonempty string of at most 6000 characters, and never revised prose. The runtime envelope binds `recursion.postProcessGuidance.v1`, `snapshotHash`, and `sourceHash` locally. Guidance routing and certification are separate from prose writing.

## Writer ownership

`postProcess.writer` contains:

```js
{
  mode: 'native', // or 'profile'
  connectionProfileId: '',
  maxOutputTokens: null,
  samplerMode: 'profile', // or 'override'
  samplerOverrides: { temperature: 0.7, topP: 1 }
}
```

The native default installs a transient editing packet and calls `context.generate('quiet', { automatic_trigger: true, quiet_prompt: writerDirective, quietToLoud: true, signal })`. It retains the active host preset, model, sampling, and host-managed context. Returned text is settled separately through guarded host mutation.

The profile route resolves a saved Connection Manager profile and dispatches request-local prose generation. It imports the selected profile's sampling and required completion formatting, not a full narrative preset that asks for continuation. It must not mutate the active main connection or fall back to another writer. It sends no JSON schema, requests no JSON repair, and does not require Utility/Reasoner certification.

The output budget inherits the selected saved profile preset when present; otherwise the user must provide an integer from 256 to 65536. Optional temperature (0..2) and top-p (0..1) overrides are request-local. Invalid edits fail before persistence. Persisted settings normalize to the current shape.

Profile writing receives the full draft, ordered cards, validated guidance, scope/style, and bounded supporting evidence. It does not promise native World Info or Author's Note equivalence. Known context-limit failures are reported without cutting required input. The selected provider remains responsible for limits that cannot be checked reliably with its tokenizer.

Resolve effective model, output budget, samplers, and profile/preset fingerprint at operation creation. Later dispatches and reuse must validate the fingerprint and stop if configuration changed. Store safe labels and fingerprints, never secrets. Both writers use the same prose-result boundary: unchanged nonempty text is a successful no-op; empty, truncated, failed, and canceled results are not accepted revisions.

## Editing scope, style, and precedence

Settings add `editingScope: 'polish' | 'revise'` (default Polish) and `reviewBeforeApplying: boolean` (default false). Deck settings version 4 adds `styleBrief` and `styleSample`. Limits are 2000 and 6000 characters. Empty text is valid; oversize editing/import input is rejected without truncation. Copy, save, rename, import, and export preserve the fields. The bundled deck has empty read-only style fields; copy it before editing.

Guidance and prose writing both receive this order of precedence:

1. Preserve narrative events, outcomes, user agency, consent, and character knowledge.
2. Obey the selected editing scope.
3. Apply enabled cards in deck order.
4. Apply the brief and use the sample only for style.

Polish improves narration phrasing, rhythm, readability, and local paragraph structure while preserving spoken dialogue wording. Attribution and punctuation may be corrected. Revise permits restructuring and dialogue rephrasing while preserving intent, established voice, events, outcomes, tense, and viewpoint. Neither scope permits new actions, decisions, revelations, attraction, boundaries, or endings.

Follow Through can clarify an action already performed in the draft. It cannot complete an action left unperformed. Character facts do not grant unacquired knowledge. The sample supplies rhythm and texture only: its names, facts, plot, commands, and distinctive phrases are not content to import. Comparison remains necessary for judging meaning; these prompts do not prove semantic preservation.

## Unified and Progressive

Unified is recommended: frozen original -> combined ordered guidance -> selected writer -> candidate -> review or commit.

Progressive runs guidance and writing once per runnable category, in order. Each successful draft becomes the next category's writable draft, while supporting evidence remains frozen. The writer is the same for every category. With no runnable cards there is no model work, even if the deck has style text.

Accepted guidance and drafts are checkpointed. A writer retry can reuse matching guidance; it does not automatically repeat successful analysis. Failed durable stages pause at their recoverable frontier. Stop aborts active calls and prevents late results from mutating chat; recovery uses fresh cancellation ownership. Internal writer and revision-selection events must not recursively arm another Post-process operation.

`Attempts per step` and operation recovery/deadline policies still apply to model work. Waiting for review is not an active model call and must release generation controls rather than consume a generation deadline.

## Comparison and settlement

Persist the original and candidate before application. `Review before applying` leaves the host response unchanged and exposes a pending review. Otherwise the completed candidate uses the selected As Swipe or Replace mode. As Swipe appends/selects the revision; Replace updates the verified current target. Partial-result settlement, where supported, uses As Swipe rather than Replace.

Each comparison binds an immutable original identity separately from the currently writable target identity. Every mutation rechecks chat, turn, message, swipe, text hash, character, and group. A Recursion marker alone does not authorize editing a changed target. Concurrent actions serialize, and revision-specific receipts plus host markers reconcile a mutation whose local receipt was lost.

Review actions follow these contracts:

- **Use revision:** apply the candidate once through the guarded host commit path.
- **Keep original:** discard a pending candidate without mutation, or restore the verified original from an owned applied result. As Swipe selects the original without deleting other swipes; Replace restores only while the target still matches the owned candidate.
- **Edit revision:** save nonempty candidate text with a new hash/revision identity, then use the same guarded application path.
- **Try another revision:** start from the immutable original, use current editing settings, and present the new candidate for review. The prior applied result remains until acceptance.

Retry may reuse guidance only when source/evidence, scope, cards, style, guidance configuration, and prompt version match. Writer-only changes invalidate writer results while permitting matching guidance reuse. Progressive retry restarts the draft chain from the original; later guidance depends on the newly produced earlier draft. New turns or externally changed source/context invalidate retry eligibility.

## Retention and privacy

Comparison records use `recursion.postProcessComparison.v1` and live in repository storage, separate from execution manifests, progress rows, normal diagnostics, and host message metadata. They retain original/candidate text, hashes, target binding, writer/scope metadata, state, retry inputs, and receipt. Retain at most ten completed comparisons per chat and protect pending review. Release retry-only evidence/guidance when stale or rejected; remove disposable Progressive intermediate drafts after settlement.

Reset Turn Cache, chat cleanup, storage repair, and retention must recognize comparison records. Missing or expired originals yield an unavailable result; do not reconstruct text or offer unsafe restoration. Storage failure must preserve the host source, especially before Replace. Diagnostics contain safe structural metadata, not comparison prose, raw prompts, hidden reasoning, or secrets.

The host marker remains `recursion.postProcessMarker.v1`. It identifies source/candidate/revision ownership and settlement without embedding original or revised bodies. Host mutation and local receipt persistence are separate boundaries; duplicate acceptance or reload must reconcile rather than append again.
