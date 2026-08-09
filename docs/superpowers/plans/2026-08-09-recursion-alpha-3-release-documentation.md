# Recursion Alpha.3 Release Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Bump the refactor branch to `0.2.0-alpha.3` and publish a concise, source-backed release checkpoint for the refactored runtime before merge.

**Architecture:** Keep existing user, technical, architecture, and verification manuals as canonical sources. Add one release-facing note that summarizes the refactor contract and links to those manuals, then align version identity and alpha-gate assertions across package metadata, the extension manifest, persisted runtime records, and documentation indexes.

**Tech Stack:** JSON, JavaScript modules, Markdown, Node.js test scripts, PowerShell.

## Global Constraints

- Preserve the pre-alpha V1 contract; do not add legacy compatibility language or migration shims.
- Keep release claims grounded in the `refactor` branch source, tests, and recorded verification documents.
- Do not expose credentials, endpoints, raw prompts, raw model output, hidden reasoning, or full transcript text in release documentation.
- Work only in `F:\git\Recursion\.worktrees\resumable-pipeline-execution` on branch `refactor`.

---

### Task 1: Update the release identity contract

**Files:**
- Modify: `package.json:3`
- Modify: `package-lock.json:3,9`
- Modify: `manifest.json:3`
- Modify: `src/storage.mjs:24`
- Modify: `tools/scripts/test-alpha-gate.mjs:13,96-101`

**Interfaces:**
- Produces one release identity: `0.2.0-alpha.3` in package metadata, extension metadata, persisted runtime records, and alpha-gate expectations.

- [ ] **Step 1: Confirm the current identity assertions**

Run:

```powershell
git grep -n '0.2.0-alpha.2' -- package.json package-lock.json manifest.json src/storage.mjs tools/scripts/test-alpha-gate.mjs
```

Expected: the current alpha.2 values are present only in the files listed for this task.

- [ ] **Step 2: Replace alpha.2 with alpha.3 in the identity files and gate**

Update the version strings and alpha-gate release-note URL/assertion text to `0.2.0-alpha.3`. Keep package-lock metadata synchronized with package.json.

- [ ] **Step 3: Verify the identity values**

Run:

```powershell
$p = Get-Content package.json -Raw | ConvertFrom-Json
$m = Get-Content manifest.json -Raw | ConvertFrom-Json
$l = Get-Content package-lock.json -Raw | ConvertFrom-Json
"PACKAGE=$($p.version)"
"MANIFEST=$($m.version)"
"LOCK=$($l.version)"
Select-String -Path src/storage.mjs -Pattern "RECURSION_VERSION"
Select-String -Path tools/scripts/test-alpha-gate.mjs -Pattern "alpha.3"
```

Expected: every reported release identity is `0.2.0-alpha.3`.

### Task 2: Write the alpha.3 release note and indexes

**Files:**
- Create: `docs/release/0.2.0-alpha.3.md`
- Modify: `docs/release/README.md:7`
- Modify: `docs/DOCUMENTATION_INDEX.md:8`

**Interfaces:**
- Consumes: canonical manuals already present on `refactor`.
- Produces: a release-facing route from both release indexes to the alpha.3 checkpoint.

- [ ] **Step 1: Write the release note**

Create a concise note with these sections:

```markdown
# Recursion `0.2.0-alpha.3`

## Release summary
## Refactored execution
## Provider and pipeline contract
## Fresh turns, reuse, and recovery
## Storage and privacy
## Upgrade expectations
## Verification
## Known alpha constraints
```

Describe only behavior supported by the existing branch docs and source. Link to `docs/technical/RECURSION_TECHNICAL_MANUAL.md`, `docs/technical/RUNTIME_TURN_SEQUENCE.md`, `docs/user/PROVIDER_SETUP.md`, `docs/architecture/CACHE_USE_AND_REUSE_SPEC.md`, `docs/technical/STORAGE_AND_DIAGNOSTICS.md`, `docs/testing/TESTING_STRATEGY.md`, and the dated `docs/verification/` records where relevant.

- [ ] **Step 2: Add alpha.3 to both indexes**

Place `[0.2.0-alpha.3](0.2.0-alpha.3.md)` before alpha.2 in `docs/release/README.md` and place the corresponding `release/0.2.0-alpha.3.md` link before alpha.2 in `docs/DOCUMENTATION_INDEX.md`.

- [ ] **Step 3: Check the Markdown change**

Run:

```powershell
git diff --check
rg -n '0.2.0-alpha.3|0.2.0-alpha.2' docs/release docs/DOCUMENTATION_INDEX.md
```

Expected: alpha.3 is the newest indexed release; alpha.2 remains only as a historical note and index entry.

### Task 3: Run release verification and review the final scope

**Files:**
- Test: repository test suite and alpha gate.
- Review: all changed files from Tasks 1-2.

**Interfaces:**
- Consumes: the updated release identity, note, and indexes.
- Produces: verified alpha.3 release evidence and a clean, bounded branch diff.

- [ ] **Step 1: Run the offline test suite**

Run:

```powershell
npm.cmd test
```

Expected: exit code 0 with all deterministic tests passing.

- [ ] **Step 2: Run the alpha gate**

Run:

```powershell
node tools\scripts\run-alpha-gate.mjs
```

Expected: exit code 0, including source, manifest, persisted-version, release-index, provider-contract, and focused regression checks.

- [ ] **Step 3: Validate changed documentation links and markers**

Run:

```powershell
rg -n '\]\([^)]+' docs/release/0.2.0-alpha.3.md
rg -n '^<Render Needed>:' README.md docs --glob '*.md' --glob '!docs/planning/DOCUMENTATION_EXPANSION_PLAN.md'
```

Expected: every release-note link points to an existing file; existing render markers are unchanged and no new render dependency is introduced by the release note.

- [ ] **Step 4: Review the final diff and commit**

Run:

```powershell
git status --short
git diff --stat
git diff --check
git add package.json package-lock.json manifest.json src/storage.mjs tools/scripts/test-alpha-gate.mjs docs/release/0.2.0-alpha.3.md docs/release/README.md docs/DOCUMENTATION_INDEX.md docs/superpowers/plans/2026-08-09-recursion-alpha-3-release-documentation.md
git commit -m "docs: prepare alpha.3 release checkpoint"
```

Expected: the commit contains only the approved version, release-note, index, plan, and verification-contract changes.
