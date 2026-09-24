# Post-process Writer and Revision Review

Date: 2026-09-23
Status: Approved by user; implementation and push authorized with no further approval checkpoints
Workspace: C:/Users/Keptin/.codex/worktrees/post-process-writer/Recursion
Baseline: 01a2d63f9d2b615710bae050d48cd0a364d318ae

## Intent and release boundary

Allow a user to keep their main SillyTavern model for scene generation and select a
different prose model to edit the completed response. Preserve Recursion's
contextual Utility/Reasoner guidance, ordered Post-process cards, durable execution,
native Stop, and guarded message settlement.

The first release includes a writer choice, Polish/Revise editing scopes, a
deck-owned style brief and sample, original/revised comparison, explicit acceptance,
manual candidate editing, and another revision from the original. Completed work
must be verified and pushed to main. Work stays in the isolated worktree.

Unified remains the recommended flow. Progressive remains available with the same
writer for every category. Per-category writer overrides, Transform scope, arbitrary
historical bulk rewriting, and persistent intermediate category comparisons are
outside this release.

## Current boundaries verified in source

- settings.mjs defaults Post-process to off, Unified, As Swipe, and 13 evidence messages.
- post-process-guidance.mjs returns structured guidanceText through Utility/Reasoner.
- post-process-runtime.mjs freezes the source, deck/categories, evidence, and settings,
  then uses host.generation.rewriteWithPostProcess and guarded final commit.
- hosts/sillytavern/host.mjs implements the writer with context.generate("quiet").
  Its existing Connection Profile transport supports request-local profile selection.
- storage.mjs purges completed Post-process source, guidance, and intermediate drafts,
  retaining the final draft and commit receipt. Comparison/retry therefore needs an
  explicit retained artifact contract; retaining a manifest reference alone is insufficient.
- The bundled starter deck is read-only; style editing must follow its existing
  copy-to-custom-deck workflow.
- Some Follow Through cards ask the model to complete actions. The scopes in this
  release intentionally prohibit introducing an event absent from the source draft.

## Product controls

Keep controls in the existing compact Post-process panel, using DESIGN.md and
docs/design/UI_SPEC.md. Do not add a second dashboard or another top-level toolbar.

Primary controls:
- Writer: Current SillyTavern model (default) or Connection Profile.
- Connection Profile selector, shown only for the profile writer.
- Editing scope: Polish (default) or Revise.
- Existing Unified/Progressive and As Swipe/Replace controls.
- Review before applying: off by default.
- Deck Style section with a short brief and optional example.

Advanced writer controls appear for the profile writer:
- Output token limit, inheriting the profile when unset.
- Sampling: Profile (default) or explicit temperature/top-p overrides.
- Existing evidence-message control, labeled to explain that the profile writer
  receives this bounded editing context rather than the entire native host prompt.

Current-model rewriting keeps native host sampling, preset, and context behavior.
Profile-specific overrides never mutate or override the active main connection.
Missing/deleted/unsupported profiles display an actionable error without fallback. If the selected profile does not expose an output budget, require an explicit output limit rather than borrowing the active main profile budget.

The bundled deck shows its style fields read-only and offers the existing copy
workflow. Custom deck editing, duplication, rename, save, import, and export preserve
the brief and example as ordinary deck fields.

## Settings and deck contract

Extend the coherent current Post-process settings with:
- writer.mode: native or profile.
- writer.connectionProfileId: required in profile mode.
- writer.maxOutputTokens: null for profile inheritance, otherwise an integer from 256 to 65536.
- writer.samplerMode: profile or override.
- writer.samplerOverrides: validated temperature and topP when overrides are enabled.
- editingScope: polish or revise.
- reviewBeforeApplying: boolean.

Keep applyMode and rewriteFlow independent. Review before applying determines
when settlement happens; applyMode determines the eventual message mutation.

Add styleBrief and styleSample to the Post-process deck schema and import/export.
Use character limits of 2000 and 6000 respectively with visible validation. Reject
oversized supplied text at editing/import boundaries instead of silently shortening
it. Empty values are valid. The bundled default contains empty values.

Bump the relevant current schemas/versions in place and update fixtures and examples.
Do not add old-shape migration branches or a second legacy writer implementation.
Post-process still requires at least one runnable card; a style brief does not
silently enable processing when all cards are disabled.

## Editing contract and precedence

Both guidance synthesis and the prose writer receive the editing scope and style
direction. Precedence is:
1. Preserve narrative events, outcomes, user agency, consent, and character knowledge.
2. Obey the selected editing scope.
3. Apply enabled cards in deck order.
4. Apply the style brief and use the sample only as a stylistic example.

Polish:
- Improve narration phrasing, sentence rhythm, readability, and local paragraph structure.
- Remove redundant narration while preserving consequential information.
- Preserve spoken dialogue wording; surrounding attribution/punctuation can be corrected.
- Preserve deliberate fragments, repetition, character voice, tense, and viewpoint.

Revise:
- Permit substantial restructuring within the response and dialogue rephrasing.
- Preserve dialogue intent, established voice, events, outcomes, tense, and viewpoint.
- Do not add a new action, decision, revelation, attraction, boundary change, or ending.

A Follow Through card may tighten an action already present in the draft, but cannot
complete an action the draft leaves unperformed. Update starter descriptions,
instructions, and user documentation to state this boundary. Character facts are
not permission to narrate knowledge a character has not acquired.

The style sample supplies rhythm and texture only. Its names, facts, plot, commands,
and distinctive phrases are not material to import. Treat all evidence and samples
as data, not higher-priority instructions. Do not promise deterministic semantic
preservation: comparison remains necessary for judging meaning.

## Writer request and context

Introduce a focused writer-contract module shared by both writer modes. Freeze a
typed packet containing source identity, complete writable draft, enabled ordered
cards, validated guidance, scope, style brief/sample, and supporting evidence.

For a profile writer:
- Use the existing request-local Connection Manager service and secret handling.
- Return prose, without JSON mode/schema, JSON repair, or Utility/Reasoner certification.
- Preserve the complete draft and edit instructions. Budget supporting evidence as
  whole fields/messages and record omissions; never slice the draft or JSON text.
- Include the latest user message, selected recent visible messages, character context,
  applicable Pre-process guidance, and story form from the frozen snapshot.
- Import profile sampling and necessary text-completion formatting, not unrelated
  full chat/system preset instructions that ask for a new narrative continuation.
- Do not claim native World Info/Author's Note equivalence. Document the available
  evidence and omissions so users understand this editing-context boundary.
- If mandatory input cannot fit, report a context-limit failure; do not silently cut it.

Resolve the profile, model, effective output budget, sampler values, and prompt
contract at operation creation. Verify their fingerprint before later dispatches,
Resume, and Retry; changed configuration invalidates reuse rather than switching
models midway. Persist configuration hashes and safe display labels, never secrets.

Native writing keeps the existing quiet-generation route and transient packet
ownership. Both routes normalize prose, empty output, truncation, provider errors,
and cancellation through the same writer-result contract. Unchanged valid prose
is a successful no-op. A known truncated result must not be accepted as complete.

## Durable execution and review state

Unified:
source snapshot -> guidance -> writer -> candidate -> review or guarded commit.

Progressive:
source snapshot -> (guidance -> writer) for each runnable category in order ->
final candidate -> review or guarded commit.

Accepted guidance and progressive drafts remain checkpointed. Preserve current
attempt/deadline policies and fresh cancellation ownership. Retry of a failed writer
does not recompute valid guidance. Stop prevents late writes even if a provider
ignores cancellation. Internal writer events never schedule recursive processing.

When reviewBeforeApplying is true:
- Store the completed candidate durably and expose Awaiting review.
- Release native generation controls; waiting for a human is not an active model call.
- Do not consume an execution deadline while waiting.
- Do not change the host response until Use revision is invoked.
- A new turn/source edit/character change invalidates mutation eligibility. The
  comparison may remain readable, but application/retry is disabled with a reason.

Review is not represented as a provider failure or an indefinitely running stage.
Application reacquires ownership and verifies identity immediately before mutation.
Concurrent Apply/Keep/Retry actions serialize by revision identity.

## Comparison and actions

Expose Compare revision on the corresponding processed message and in Post-process
results. For a pending candidate use Review revision. Supply a keyboard-accessible
native-styled dialog with clean reading and highlighted-change views. Escape all
text; generated HTML must not become active markup. Use bounded diff computation
with a coarse paragraph fallback for large input. Preserve chat scroll and focus.

Show original/revised text, scope, writer label, and pending/applied/stale status.
Do not display hidden reasoning, raw request payloads, or unsupported quality scores.

Actions:
- Keep original: for pending review, discard the candidate without chat mutation.
  For an owned As Swipe result, select the verified original swipe without deleting
  generated swipes. For an owned Replace result, restore the retained original only
  while the current target still exactly matches Recursion's applied candidate.
- Use revision: commit once using As Swipe or Replace after a final identity/hash
  check. Repeated acceptance/reload does not append a duplicate swipe.
- Edit revision: edit candidate text locally; reject empty input, save a new candidate
  hash, then use the same guarded acceptance path. Mark manual editing in safe metadata.
- Try another revision: generate a new candidate from the immutable original,
  never from the preceding rewrite, and always show it for review before applying.
  The prior applied text remains until an explicit acceptance.

The original text identity and currently writable target identity are distinct.
After automatic application, a retry must validate the owned selected result as
the current target while using the original as the rewrite baseline. Do not bypass
the source guard merely because the target bears a Recursion marker.

Each candidate revision has a new id and commit receipt. Trying another revision
must not reuse the previous candidate's commit receipt. In Progressive mode restart
the draft chain from the original. Only checkpoints whose complete inputs match
may be reused; later-category guidance depends on the newly generated earlier draft.

Reuse guidance when source/evidence, scope, cards, style, guidance model/settings,
and prompt version remain unchanged. Writer-only setting changes can preserve
guidance but invalidate writer results. Editing inputs refresh guidance against the
same eligible original and captured evidence. An external source/context change
requires a fresh operation rather than repurposing the old comparison.

## Comparison storage, retention, and privacy

Use the existing repository/logical-storage infrastructure with explicit comparison
records and index references. Do not store full bodies in host message metadata,
diagnostics, progress rows, or execution manifests.

A comparison record contains:
- Original identity/text, current candidate identity/text, exact applied-target binding.
- Safe writer/scope metadata and operation/candidate/receipt hashes.
- Frozen editing input and guidance artifacts necessary for an eligible same-turn retry.
- Review state and timestamps.

Retain at most ten completed comparisons per chat, using least-recently-used cleanup
and the repository's overall storage-budget policy. Protect the current pending
review until explicitly rejected, made stale, or Reset Turn Cache is used. On new
turn/staleness release retry-only evidence/guidance promptly; keep only original/final
comparison text and safe structural metadata within the retention limit.

Delete progressive intermediate drafts after successful settlement. Reopening only
requires original/final text. Retention, reset, chat deletion, repair, and orphan
cleanup must recognize comparison references and must not leave stranded raw bodies.
Reset Turn Cache clears the active turn's comparison/retry artifacts without changing
SillyTavern messages. Missing/expired comparison data yields an unavailable explanation,
never reconstructed or invented original text.

If comparison persistence fails, do not silently perform a Replace that loses the
only retained original. Surface a storage failure and preserve the source. Keep host
commit and local receipt reconciliation idempotent across crashes between mutation
and receipt persistence.

## Code ownership and integration boundaries

Expected affected modules:
- settings.mjs and post-process-decks.mjs: normalized settings and deck data.
- post-process-guidance.mjs and a focused writer-contract module: prompts and evidence.
- hosts/sillytavern/host.mjs and profile helpers: isolated prose transport and guarded actions.
- post-process-runtime.mjs, execution contracts, and runtime.mjs: checkpoints, review, retries.
- storage.mjs and retention contracts: comparison artifacts and cleanup.
- A focused comparison UI module plus existing ui.mjs integration and styles.
- extension/index.js: message actions and nonrecursive lifecycle ownership.

Keep substantial comparison logic out of the already-large ui.mjs/runtime.mjs files.
Reuse host mutation and storage primitives; do not build a separate unguarded commit
path or a second provider registry. Update architecture/user/design documentation,
schema fixtures, deck examples, and visual examples together.

## Verification and completion evidence

Before implementation, the clean worktree baseline passed all 83 offline test scripts.
That baseline is setup evidence, not proof of the proposed functionality.

Required verification:
1. Settings/deck normalization, validation, clone and import/export round trips;
   bundled deck copy behavior and empty/oversized style text.
2. Scope precedence and prompt inputs, full draft preservation, evidence omissions,
   sample isolation, and documentation for Follow Through restrictions.
3. Profile prose request payloads: correct profile/model/samplers/token limits,
   no schema/JSON repair/full narrative preset, no active-connection mutation.
4. Native writer regression; provider failure/truncation/no-op/Stop/late-result behavior.
5. Unified and Progressive profile/native routes; frozen configuration and stage reuse.
6. Pending review survives recreation; native controls release; stale/new-turn handling.
7. Guarded As Swipe/Replace/restore/edit/retry, duplicate actions, crash reconciliation,
   writer-only versus guidance-input invalidation, and retry from the true original.
8. Bounded retention, reset/deletion/orphan cleanup, diagnostics privacy, and storage failure.
9. Browser evidence for selectors, style editing, comparison/diff/clean view, manual
   edits, retry, keyboard/focus/scroll, narrow layouts, and stale-action messaging.
10. Host integration through a dedicated test fixture/account, with native/profile
    generation and application evidence. Do not alter the running user's host config
    or chats to obtain proof; use isolated test data and redact raw narrative artifacts.
11. Run the full offline suite and required browser/host checks; review the final diff,
    audit every requirement, then push scoped commits to main using non-force integration.
    Recheck remote main before integration and preserve concurrent/unrelated changes.

The user has authorized the final push to main. Do not ask for a second integration
approval. This document does not claim the features are implemented or verified.
