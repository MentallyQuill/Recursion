# Recursion `0.2.0-alpha.3` Release Documentation Design

## Goal

Prepare the refactor branch for merge by documenting the `0.2.0-alpha.3` contract, bumping all release identity surfaces coherently, and making the release evidence discoverable from the public documentation route.

## Context

The refactor branch already contains the broad documentation rewrite for the new execution architecture. The release pass should therefore add a focused checkpoint rather than rewrite those manuals again. The current branch contract includes resumable stage execution, Segmented and Fused pipelines, SillyTavern Connection Profile routing and certification, turn-scoped reuse, dependency-aware invalidation, and explicit Stop/Resume/Retry/Reprocess behavior.

Recursion remains pre-alpha/alpha software. The current V1 contract replaces obsolete runtime shapes in place; this release must not promise compatibility with old execution artifacts or legacy provider settings.

## Approach

Create `docs/release/0.2.0-alpha.3.md` as the release-facing summary and link it from the release directory and canonical documentation index. Keep detailed behavior in the existing user, technical, architecture, testing, and verification documents, linking to those sources from the note instead of duplicating their full contracts.

Update the release identity in `package.json`, `package-lock.json`, `manifest.json`, and the persisted runtime version constant in `src/storage.mjs`. Update the alpha-gate assertions in `tools/scripts/test-alpha-gate.mjs`. Preserve the prior alpha notes as historical checkpoints.

## Release-note content

The new note will contain:

- a concise release summary;
- user-visible changes: resumable execution, clearer progress actions, Segmented/Fused pipeline behavior, provider policy controls, and turn-bound reuse;
- the operational contract for fresh turns, unchanged swipes, stale work, Stop, Resume, Retry Stage, queued Reprocess, and Full Rebuild;
- the Connection Profile and certification boundary, including the distinction between Segmented and Fused eligibility;
- privacy and storage boundaries for checkpoint artifacts, diagnostics, credentials, prompts, and provider output;
- upgrade expectations for this pre-alpha contract replacement;
- verification commands and the branch's recorded verification documents;
- known alpha constraints, including provider availability, no automatic retry of SillyTavern's primary story generation, and no default generation timeout.

## Files

Create:

- `docs/release/0.2.0-alpha.3.md`

Modify:

- `package.json`
- `package-lock.json`
- `manifest.json`
- `src/storage.mjs`
- `tools/scripts/test-alpha-gate.mjs`
- `docs/release/README.md`
- `docs/DOCUMENTATION_INDEX.md`

## Verification

Run the repository's offline suite and alpha gate from the refactor worktree:

```powershell
npm.cmd test
node tools\scripts\run-alpha-gate.mjs
```

Also verify that all version identity surfaces report `0.2.0-alpha.3`, the new release note is linked from both release indexes, Markdown links in the changed documentation resolve, and the final diff is limited to the approved release/documentation scope.

## Constraints

- Do not add legacy compatibility shims or legacy runtime-artifact promises.
- Keep release claims grounded in the refactor branch source, tests, and existing verification records.
- Do not expose provider credentials, endpoints, raw prompts, raw model output, hidden reasoning, or full transcript text in release documentation.
- Keep the release note concise and link to canonical manuals for detailed contracts.
