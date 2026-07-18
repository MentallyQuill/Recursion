# Redirect Readiness Copy and Progress Row Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Redirect's normal description immediately after Reasoner becomes ready and prevent routine Fused child-row explanations from overlapping compact progress rows.

**Architecture:** Keep the shared provider-capability resolver authoritative. Make the Enhancements renderer reset every Redirect presentation field to its canonical option metadata before overlaying an unavailable state. Keep progress reason data available for diagnostics and tooltips, but render a visible reason subline only for warning and failed rows, matching the existing design contract.

**Tech Stack:** Browser-native JavaScript ESM, DOM rendering in `src/ui.mjs`, CSS in `styles/recursion.css`, Node-based UI regression tests.

## Global Constraints

- Recursion remains SillyTavern-native, compact, graphite-dark, and mobile-safe.
- Medium-or-higher Redirect remains unavailable unless Reasoner capability is `ready`.
- Low Redirect remains Utility-backed and does not require Reasoner readiness.
- Warning and failed progress rows retain one visible wrapped sanitized reason.
- Routine generated, included, cached, and done rows retain compact fixed-height geometry.
- Do not mutate provider configuration or health semantics for this presentation-only readiness bug.

---

### Task 1: Restore Redirect presentation after readiness changes

**Files:**
- Modify: `tools/scripts/test-ui.mjs`
- Modify: `src/ui.mjs`

**Interfaces:**
- Consumes: `ENHANCEMENT_TARGET_OPTIONS`, `renderEnhancementsState(view)`, `view.settings.providerCapabilities.reasoner.redirect`
- Produces: deterministic restoration of the canonical Redirect `aria-label`, `title`, and visible tip whenever the row is available

- [x] **Step 1: Write the failing transition test**

After rendering an unavailable Medium Redirect, update the same mounted UI to a ready Reasoner and assert:

```js
assertEqual(readyRedirectChoice.disabled, false, 'ready Reasoner enables Redirect');
assertEqual(readyRedirectChoice.getAttribute('aria-label'), 'Redirect (Experimental)', 'ready Redirect restores its canonical aria label');
assertEqual(readyRedirectChoice.getAttribute('title'), 'Replace a drifted response with an evidence-grounded one.', 'ready Redirect restores its canonical title');
assertEqual(
  fakeDocument.textTree(readyRedirectChoice.querySelector('[data-recursion-enhancement-target-choice-tip]')),
  'Uses card-evidence to replace a misaligned trajectory with a stronger, verified response.',
  'ready Redirect restores its canonical description'
);
assertEqual(redirectTestReasoner.hidden, true, 'ready Redirect hides Test Reasoner');
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: FAIL because the unavailable copy remains on the mounted Redirect row.

- [x] **Step 3: Implement canonical-first rendering**

Resolve the option metadata for each target row and restore its base presentation before applying unavailable state:

```js
const option = ENHANCEMENT_TARGET_OPTIONS.find((entry) => entry.value === choiceTarget);
const canonicalLabel = option?.qualifier
  ? `${option.label} (${option.qualifier})`
  : option?.label || enhancementTargetLabel(choiceTarget);
choice.setAttribute('aria-label', canonicalLabel);
choice.setAttribute('title', option?.title || '');
const tip = choice.querySelector?.('[data-recursion-enhancement-target-choice-tip]');
if (tip) tip.textContent = option?.tip || '';
```

Then retain the existing unavailable overlay for Medium+ Redirect.

- [x] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: `[pass] ui`.

### Task 2: Restrict visible progress reasons to warning and failed rows

**Files:**
- Modify: `tools/scripts/test-ui.mjs`
- Modify: `src/ui.mjs`
- Modify: `styles/recursion.css` only if the behavior test exposes a remaining geometry issue

**Interfaces:**
- Consumes: `updateProgressRow(row, step, child, tooltipsEnabled)`
- Produces: compact routine rows with an empty reason element and expanded warning/failed rows with a visible reason

- [x] **Step 1: Write failing row-rendering tests**

Render one routine included child with a reason and one warning child with a reason. Assert:

```js
assertEqual(
  routineRow.querySelector('[data-recursion-progress-reason]').textContent,
  '',
  'routine progress rows omit visible reason copy'
);
assert(!routineRow.className.includes('has-reason'), 'routine progress rows keep compact fixed-height geometry');
assertEqual(
  warningRow.querySelector('[data-recursion-progress-reason]').textContent,
  'Provider card batch retried once.',
  'warning progress rows retain a visible reason'
);
assert(warningRow.className.includes('has-reason'), 'warning progress rows expand for their reason');
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: FAIL because the routine row currently renders its reason text.

- [x] **Step 3: Implement severity-gated visible reasons**

Keep the sanitized reason in the row dataset and tooltip input, but gate the visible subline:

```js
const visibleReason = reason && ['warning', 'failed'].includes(state) ? reason : '';
setText(row, '[data-recursion-progress-reason]', visibleReason);
if (visibleReason) addClassName(row, 'has-reason');
else removeClassName(row, 'has-reason');
```

- [x] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: `[pass] ui`.

### Task 3: Document and verify the regression

**Files:**
- Modify: `docs/planning/2026-07-17-reasoner-capability-and-redirect-readiness-fix-improvement.md`
- Modify: `DESIGN.md` only if its existing reason-row contract needs clarification
- Modify: `docs/design/UI_SPEC.md` only if its existing reason-row contract needs clarification

**Interfaces:**
- Consumes: the two passing UI regressions
- Produces: an implementation record and deployable verified tree

- [x] **Step 1: Add the post-deployment regression record**

Record that SG-1 proved Provider Test, Reasoner generation, and Redirect success while the mounted menu retained unavailable copy, and that routine Fused reasons overflowed fixed-height child rows.

- [x] **Step 2: Run focused verification**

```powershell
node tools\scripts\test-ui.mjs
node tools\scripts\test-runtime.mjs
node tools\scripts\test-provider-capability.mjs
```

Expected: all commands print `[pass]`.

- [x] **Step 3: Run repository verification**

```powershell
git diff --check
npm.cmd test
```

Expected: no whitespace errors and all registered suites pass.

- [x] **Step 4: Update and verify `default-user`**

Copy the tested production tree to the `default-user` installed extension and public served copy using the established deployment command, then run:

```powershell
node tools\scripts\verify-installed-copy.mjs --user default-user
```

Expected: repository, installed, and public production files match.

- [x] **Step 5: Perform read-only live UI verification**

Reload SillyTavern, confirm a ready Redirect shows the canonical card-evidence description with no Test Reasoner action, and inspect a mobile-width Fused progress tree to confirm routine child rows do not overlap while warning reasons remain visible.

Verification note: the separate read-only browser session loaded the served
extension but had its own unhealthy Reasoner state and no SG-1 progress tree.
No provider test, setting change, or generation was run against `default-user`.
The ready mounted-DOM transition and warning-to-routine row transition were
therefore verified through the deterministic UI regression, while the served
code was verified byte-for-byte across all 69 production files.
