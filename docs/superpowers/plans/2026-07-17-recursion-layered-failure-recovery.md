# Recursion Layered Failure Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover bounded provider-format and Redirect-reference defects while
preserving verifier authority, and make every warning or failure explain itself
across progress, journal, and live UI.

**Architecture:** Add one normalized failure module consumed by providers,
runtime, progress, and UI. Repair malformed JSON before schema validation,
normalize unknown Redirect references into diagnostics instead of terminal
semantic judgments, and give rejected Redirect candidates one final
Reasoner-writer attempt followed by mandatory re-verification.

**Tech Stack:** Browser-native ES modules, vendored `jsonrepair@3.15.0`,
SillyTavern host adapter, Node test scripts, Playwright, PowerShell.

## Global Constraints

- Recursion is pre-alpha; replace old contracts in place without compatibility
  shims.
- Healthy Redirect model-call count must remain unchanged.
- Medium and above use Reasoner for at most two Redirect writer attempts and
  never fall back to Utility.
- Every Redirect candidate must pass the production verifier before host
  mutation.
- Cancellation and supersession are neutral, not failures.
- No UI or journal surface may expose raw prompts, raw responses, hidden
  reasoning, stack traces, secrets, or unbounded provider text.
- Automated live generation uses only `recursion-soak-*`; update `default-user`
  only after all proof gates pass.
- Preserve prompt-neutral enhancements, swipe packet reuse, prompt
  reinstallation without provider calls, and frozen review identifiers.

---

## File Map

- `src/vendor/jsonrepair/`: pinned browser ESM distribution and ISC license.
- `src/failures.mjs`: normalized failure construction, sanitization, and
  provider-category mapping.
- `src/providers.mjs`: structured repair and normalized provider settlement.
- `src/editorial-transform.mjs`: runtime-owned diagnosis identities and
  recoverable Redirect-reference normalization.
- `src/runtime.mjs`: bounded Redirect retry state machine and failure
  propagation.
- `src/progress.mjs`: unhealthy-state reason invariant and aggregation.
- `src/ui.mjs`: visible reason sublines and concise status summary.
- `styles/recursion.css`: compact reason layout and state colors.
- `tools/scripts/lib/live-enhancement-run-oracle.mjs`: strict reason-aware live
  oracle.
- `tools/scripts/test-*.mjs`: focused contract and negative-control suites.
- `DESIGN.md`, `docs/design/UI_SPEC.md`,
  `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`, and
  `docs/architecture/STORAGE_AND_DIAGNOSTICS.md`: final contracts.

---

### Task 1: Vendor And Integrate Bounded JSON Repair

**Files:**
- Create: `src/vendor/jsonrepair/`
- Create: `src/vendor/jsonrepair/LICENSE.md`
- Modify: `src/providers.mjs`
- Modify: `tools/scripts/test-provider-response-parser.mjs`
- Modify: `tools/scripts/test-providers.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `jsonrepair(text: string): string` from the pinned ESM artifact.
- Produces: `parseProviderStructuredOutput(text)` diagnostics containing
  `structuredOutputRecovery`, `originalResponseHash`, and
  `repairedResponseHash`.

- [x] **Step 1: Fetch and audit the pinned package**

Run:

```powershell
npm.cmd pack jsonrepair@3.15.0 --pack-destination .tmp
tar -tf .tmp/jsonrepair-3.15.0.tgz
```

Expected: package contains `lib/esm`, `LICENSE.md`, and package metadata showing
version `3.15.0` and license `ISC`.

- [x] **Step 2: Add failing captured-response tests**

Add a sanitized fixture matching the SG-1 defect:

```js
const malformedRedirect = `{
  "sceneCharacters": [
    { "name": "Daniel", role: "Documenting" }
  ]
}`;
const repaired = parseStructuredOutput(malformedRedirect);
assertEqual(repaired.ok, true, 'unquoted Redirect key repairs locally');
assertEqual(repaired.data.sceneCharacters[0].role, 'Documenting', 'repair preserves value');
assertEqual(repaired.diagnostics.structuredOutputRecovery, 'local-json-repair', 'repair is diagnosed');
```

Add negative controls for blank text, whitespace, prose-only text, and
irreparable oversized output. Assert none are fabricated into semantic objects.

- [x] **Step 3: Run parser tests and confirm failure**

Run:

```powershell
node tools/scripts/test-provider-response-parser.mjs
node tools/scripts/test-providers.mjs
```

Expected: FAIL because strict parsing rejects the unquoted key and no local
repair diagnostics exist.

- [x] **Step 4: Vendor the ESM distribution**

Copy the package's browser ESM files and license into
`src/vendor/jsonrepair/`. Add `package.json` metadata:

```json
{
  "thirdParty": {
    "jsonrepair": {
      "version": "3.15.0",
      "license": "ISC",
      "source": "https://registry.npmjs.org/jsonrepair/-/jsonrepair-3.15.0.tgz"
    }
  }
}
```

- [x] **Step 5: Integrate strict-then-repair parsing**

In `src/providers.mjs`, keep strict parse first:

```js
function parseProviderStructuredOutput(text) {
  const strict = parseStructuredOutput(text);
  if (strict.ok) return strict;
  const originalResponseHash = responseTextHash(text);
  try {
    const repairedText = jsonrepair(String(text || ''));
    const repaired = parseStructuredOutput(repairedText);
    if (!repaired.ok) return strict;
    return {
      ...repaired,
      diagnostics: {
        ...repaired.diagnostics,
        structuredOutputRecovery: 'local-json-repair',
        originalResponseHash,
        repairedResponseHash: responseTextHash(repairedText)
      }
    };
  } catch {
    return strict;
  }
}
```

Apply existing maximum response-size limits before invoking repair.

- [x] **Step 6: Run focused tests**

Run:

```powershell
node tools/scripts/test-provider-response-parser.mjs
node tools/scripts/test-providers.mjs
```

Expected: PASS; malformed syntax recovers without a provider retry, while blank,
prose-only, and oversized content retain stable failures.

- [x] **Step 7: Commit**

```powershell
git add package.json src/vendor/jsonrepair src/providers.mjs tools/scripts/test-provider-response-parser.mjs tools/scripts/test-providers.mjs
git commit -m "fix(providers): repair malformed JSON locally"
```

---

### Task 2: Introduce The Unified Failure Descriptor

**Files:**
- Create: `src/failures.mjs`
- Create: `tools/scripts/test-failures.mjs`
- Modify: `tools/scripts/run-tests.mjs`
- Modify: `src/providers.mjs`
- Modify: `src/ui/action-status.mjs`

**Interfaces:**
- Produces:
  `createFailure(input): RecursionFailure`,
  `providerFailure(error, context): RecursionFailure`,
  `failureFrom(value, fallback): RecursionFailure`,
  `failureReason(value): string`.
- `RecursionFailure` requires `code`, `stage`, `category`, and `message`.

- [x] **Step 1: Write failure-contract tests**

Cover funds, auth, timeout, length, unsupported parameters, malformed output,
host mutation, storage, and unknown internal errors:

```js
const funds = providerFailure(
  { status: 402, message: 'Insufficient funds' },
  { stage: 'editorial-diagnosis' }
);
assertEqual(funds.category, 'provider-account', 'funds category');
assertEqual(funds.message, 'Provider account has insufficient funds.', 'safe funds reason');
assert(!JSON.stringify(funds).includes('api_key'), 'failure excludes secrets');
```

Assert generic input such as `Action failed.` becomes
`Unexpected internal failure (RECURSION_INTERNAL).`

- [x] **Step 2: Run and confirm failure**

Run:

```powershell
node tools/scripts/test-failures.mjs
```

Expected: FAIL because `src/failures.mjs` does not exist.

- [x] **Step 3: Implement the normalized descriptor**

Use the approved shape:

```js
export function createFailure(input = {}) {
  const code = safeCode(input.code || 'RECURSION_INTERNAL');
  return Object.freeze({
    code,
    stage: safeStage(input.stage || 'runtime'),
    category: knownCategory(input.category) ? input.category : 'internal',
    message: safeMessage(input.message, code),
    ...(input.retryable === true ? { retryable: true } : {}),
    ...(safeOptional(input.attemptedRecovery)
      ? { attemptedRecovery: safeOptional(input.attemptedRecovery) } : {}),
    ...(safeOptional(input.suggestedAction)
      ? { suggestedAction: safeOptional(input.suggestedAction) } : {})
  });
}
```

Provider mapping must use status codes, stable provider error codes, finish
reasons, and known message patterns without copying raw provider text.

- [x] **Step 4: Replace provider and action-status generic failures**

Make provider settlement include:

```js
const failure = providerFailure(error, { stage: roleStage(roleId), request });
detail: { ...diagnostics, error: safeError, failure }
```

Make `normalizeUiActionFailure` return the same descriptor and a label derived
from `failure.message`.

- [x] **Step 5: Register and run tests**

Run:

```powershell
node tools/scripts/test-failures.mjs
node tools/scripts/test-providers.mjs
node tools/scripts/test-ui.mjs
```

Expected: PASS; every provider hard failure and UI action failure exposes a
bounded specific reason.

- [x] **Step 6: Commit**

```powershell
git add src/failures.mjs src/providers.mjs src/ui/action-status.mjs tools/scripts/test-failures.mjs tools/scripts/run-tests.mjs tools/scripts/test-providers.mjs tools/scripts/test-ui.mjs
git commit -m "feat: normalize extension failure reasons"
```

---

### Task 3: Normalize Redirect Identity And Evidence References

**Files:**
- Modify: `src/providers.mjs`
- Modify: `src/editorial-transform.mjs`
- Modify: `tools/scripts/test-editorial-transform.mjs`
- Modify: `tools/scripts/test-provider-response-parser.mjs`

**Interfaces:**
- Produces runtime-owned diagnosis identity in
  `normalizeRoleResponseEnvelope`.
- Produces `validateEditorialDiagnosis(...).diagnostics.referenceIssues[]`.
- Preserves mandatory verifier authority.

- [x] **Step 1: Write failing identity and reference tests**

Add cases proving:

```js
assertEqual(normalized.sourceHash, request.sourceHash, 'source hash is runtime-owned');
assertEqual(normalized.snapshotHash, request.snapshotHash, 'snapshot hash is runtime-owned');

const result = validateEditorialDiagnosis(redirectWithUnknownRef, fixture);
assertEqual(result.ok, true, 'unknown reference does not terminate diagnosis');
assertEqual(result.value.brief.requiredBeats[0].evidenceRefs.length, 0, 'unknown ref is removed');
assertEqual(
  result.diagnostics.referenceIssues[0].path,
  'requiredBeats[0].evidenceRefs[0]',
  'diagnostic identifies exact field'
);
```

Add a terminal negative control where normalization leaves no replacement
objective or required beat.

- [x] **Step 2: Run and confirm failures**

Run:

```powershell
node tools/scripts/test-editorial-transform.mjs
node tools/scripts/test-provider-response-parser.mjs
```

Expected: FAIL because identity is trusted from the model and unknown references
terminate validation.

- [x] **Step 3: Make identity runtime-owned**

For `editorialDiagnostician`, overwrite schema, mode, hashes, and Redirect
decision from the request after parse and before role validation.

- [x] **Step 4: Return reference diagnostics instead of semantic failure**

Replace the aggregate `knownRefs` failure with path-aware normalization:

```js
function normalizeKnownRefs(values, known, path, issues) {
  return list(values).filter((reference, index) => {
    if (known.has(reference)) return true;
    issues.push({
      code: 'RECURSION_EDITORIAL_REDIRECT_REFERENCE_DROPPED',
      path: `${path}[${index}]`,
      reference: safeText(reference, 180)
    });
    return false;
  });
}
```

Do not replace references or claims. Return a precise structural error only when
required semantic fields become unusable.

- [x] **Step 5: Run focused tests**

Run:

```powershell
node tools/scripts/test-editorial-transform.mjs
node tools/scripts/test-provider-response-parser.mjs
```

Expected: PASS; known references remain unchanged, unknown references are
diagnosed, and structurally empty Redirects still fail.

- [x] **Step 6: Commit**

```powershell
git add src/providers.mjs src/editorial-transform.mjs tools/scripts/test-editorial-transform.mjs tools/scripts/test-provider-response-parser.mjs
git commit -m "fix(redirect): defer evidence judgment"
```

---

### Task 4: Implement Bounded Redirect Writer And Verifier Recovery

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `src/editorial-transform.mjs`
- Modify: `tools/scripts/test-editorial-runtime.mjs`

**Interfaces:**
- Consumes diagnosis `referenceIssues`.
- Produces one or two verified writer attempts.
- Never mutates the host without verifier acceptance.

- [x] **Step 1: Add failing runtime state-machine tests**

Add fixtures asserting:

```js
assertEqual(referenceRecovery.state.transformAttempts, 1, 'reference issue adds no writer call');
assertEqual(referenceRecovery.state.verifierAttempts, 1, 'reference issue reaches verifier');
assertEqual(referenceRecovery.state.appendAttempts, 1, 'accepted result appends once');

assertEqual(rejectedThenCorrected.state.transformAttempts, 2, 'one rejected candidate retries writer');
assertEqual(rejectedThenCorrected.state.verifierAttempts, 2, 'replacement is reverified');
assertEqual(rejectedThenCorrected.result.ok, true, 'verified replacement applies');

assertEqual(rejectedTwice.state.transformAttempts, 2, 'writer budget is bounded');
assertEqual(rejectedTwice.state.appendAttempts, 0, 'repeated rejection preserves original');
```

Assert Medium+ attempts both use Reasoner and Low attempts both use Utility.

- [x] **Step 2: Run and confirm failure**

Run:

```powershell
node tools/scripts/test-editorial-runtime.mjs
```

Expected: FAIL because verifier rejection currently terminates without a
corrected writer candidate.

- [x] **Step 3: Pass reference diagnostics into transform and verify prompts**

Add bounded diagnostic evidence:

```js
diagnosisDiagnostics: {
  referenceIssues: diagnosisValidation.diagnostics?.referenceIssues || []
}
```

Prompts state that dropped references are unresolved and do not establish
support.

- [x] **Step 4: Implement the two-attempt writer loop**

Refactor the Redirect writer/verifier sequence:

```js
for (let writerAttempt = 1; writerAttempt <= 2; writerAttempt += 1) {
  const candidate = await writeRedirect({ retry: writerAttempt === 2 ? verifierFeedback : null });
  const verified = await verifyRedirect(candidate);
  if (verified.decision === 'accept') return commitVerified(candidate, verified);
  verifierFeedback = {
    failedChecks: verified.failedChecks,
    reason: verified.reason
  };
}
return failEditorial(redirectRejectedFailure(verifierFeedback));
```

Reuse the existing writer lane selection. Disable Utility fallback for
Medium-and-higher Redirect. Recheck cancellation and source identity before
every call and before mutation.

- [x] **Step 5: Run focused tests**

Run:

```powershell
node tools/scripts/test-editorial-runtime.mjs
node tools/scripts/test-editorial-transform.mjs
node tools/scripts/test-providers.mjs
```

Expected: PASS; call counts, lanes, terminal failure, and host mutation are all
bounded and exact.

- [x] **Step 6: Commit**

```powershell
git add src/runtime.mjs src/editorial-transform.mjs tools/scripts/test-editorial-runtime.mjs
git commit -m "fix(redirect): retry rejected writer once"
```

---

### Task 5: Propagate And Render Visible Failure Reasons

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `src/progress.mjs`
- Modify: `src/ui.mjs`
- Modify: `styles/recursion.css`
- Modify: `tools/scripts/test-progress.mjs`
- Modify: `tools/scripts/test-ui.mjs`

**Interfaces:**
- Every warning/failed activity carries `detail.failure`.
- Every warning/failed progress step carries non-generic `reason`.
- UI renders `[data-recursion-progress-reason]`.

- [x] **Step 1: Add failing progress and UI tests**

Assert:

```js
const failed = model.steps.find((step) => step.id === 'editorial-diagnosis');
assertEqual(failed.state, 'failed', 'diagnosis is failed');
assertEqual(failed.reason, 'Provider returned malformed JSON after one correction.', 'reason survives');
assertThrows(
  () => createProgressRunModel(viewWithGenericFailure),
  /unhealthy progress step requires a reason/,
  'generic failures violate presenter contract'
);
```

UI source/DOM tests require a visible reason element, red/amber inherited color,
wrapping, and concise compact status. Add a long-word mobile fixture.

- [x] **Step 2: Run and confirm failures**

Run:

```powershell
node tools/scripts/test-progress.mjs
node tools/scripts/test-ui.mjs
```

Expected: FAIL because reasons are tooltip-only and `failEditorial` emits only
`reasonCode`.

- [x] **Step 3: Propagate descriptors from runtime settlements**

Replace generic terminal details:

```js
detail: {
  mode: editorialMode,
  applyMode,
  failure: failureFrom(error, {
    stage: 'editorial',
    message: 'Editorial transform failed.'
  })
}
```

Apply the same contract to provider, prompt-install, storage, cache, Generation
Review, enhancement, and host-mutation failure settlements.

- [x] **Step 4: Enforce reasons in progress normalization**

Use `detail.failure.message` before legacy fields. Throw in tests/development
when warning/failed state has no reason; production fallback uses the normalized
internal failure message and code.

- [x] **Step 5: Render reason sublines**

Create rows with:

```js
el('span', {
  className: 'recursion-step-reason',
  dataset: { recursionProgressReason: '' }
})
```

Update text and hide it for healthy states. CSS must use compact helper type,
wrap safely, inherit amber/red state color, and avoid changing fixed indicator
geometry.

- [x] **Step 6: Run focused tests**

Run:

```powershell
node tools/scripts/test-progress.mjs
node tools/scripts/test-ui.mjs
node tools/scripts/test-runtime.mjs
node tools/scripts/test-generation-review.mjs
```

Expected: PASS; no unhealthy progress state is generic or hover-only.

- [ ] **Step 7: Commit**

```powershell
git add src/runtime.mjs src/progress.mjs src/ui.mjs styles/recursion.css tools/scripts/test-progress.mjs tools/scripts/test-ui.mjs tools/scripts/test-runtime.mjs tools/scripts/test-generation-review.mjs
git commit -m "feat(ui): show failure reasons inline"
```

---

### Task 6: Enforce Global Journal And Live-Oracles

**Files:**
- Modify: `tools/scripts/lib/live-enhancement-run-oracle.mjs`
- Modify: `tools/scripts/test-live-enhancement-run-oracle.mjs`
- Modify: `tools/scripts/prove-live-enhancements.mjs`
- Modify: `tools/scripts/prove-editorial-transformation-ui.mjs`
- Modify: `tools/scripts/test-diagnostics.mjs`
- Modify: `tools/scripts/test-activity.mjs`
- Modify: `tools/scripts/run-tests.mjs`

**Interfaces:**
- Produces `assertEveryUnhealthyStateExplainsWhy`.
- Process success derives exclusively from the strict live oracle.

- [ ] **Step 1: Add false-pass negative controls**

Add:

```js
[
  { name: 'failed without reason', transitions: [{ state: 'failed', reason: '' }] },
  { name: 'warning then replaced', transitions: [
    { id: 'x', state: 'warning', reason: '' },
    { id: 'x', state: 'done', reason: '' }
  ]},
  { name: 'journal error without descriptor', journalDelta: [
    { severity: 'error', event: 'provider.call.failed', details: {} }
  ]}
]
```

Every control must produce a nonzero verdict even if the final tree is green.

- [ ] **Step 2: Run and confirm failures**

Run:

```powershell
node tools/scripts/test-live-enhancement-run-oracle.mjs
node tools/scripts/test-diagnostics.mjs
node tools/scripts/test-activity.mjs
```

Expected: FAIL because the oracle does not require visible/journal reasons.

- [ ] **Step 3: Implement the shared unhealthy-state oracle**

Require:

```js
const generic = /^(failed|failure|warning|caution|needs attention|action failed)[.!]?$/i;
const missingReason = unhealthyTransitions.filter((row) =>
  !String(row.reason || '').trim() || generic.test(String(row.reason).trim())
);
if (missingReason.length) failures.push('progress-unhealthy-without-reason');
```

Journal warning/error entries require `details.failure.message`, except explicit
test fixtures for old unrelated records outside the run delta.

- [ ] **Step 4: Make live scripts exit only from oracle verdict**

Remove independent `console.log('[pass]')` branches. Set:

```js
process.exitCode = oracle.verdict.ok ? 0 : 1;
```

Screenshots and artifacts may still be written after failure.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
node tools/scripts/test-live-enhancement-run-oracle.mjs
node tools/scripts/test-diagnostics.mjs
node tools/scripts/test-activity.mjs
node tools/scripts/test-live-harness.mjs
```

Expected: PASS; historical unhealthy states and journal-only failures cannot be
hidden by later DOM replacement.

- [ ] **Step 6: Commit**

```powershell
git add tools/scripts/lib/live-enhancement-run-oracle.mjs tools/scripts/test-live-enhancement-run-oracle.mjs tools/scripts/prove-live-enhancements.mjs tools/scripts/prove-editorial-transformation-ui.mjs tools/scripts/test-diagnostics.mjs tools/scripts/test-activity.mjs tools/scripts/test-live-harness.mjs tools/scripts/run-tests.mjs
git commit -m "test: reject unexplained unhealthy states"
```

---

### Task 7: Update Contracts, Verify, And Deploy

**Files:**
- Modify: `DESIGN.md`
- Modify: `docs/design/UI_SPEC.md`
- Modify: `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`
- Modify: `docs/architecture/STORAGE_AND_DIAGNOSTICS.md`
- Modify: `docs/superpowers/specs/2026-07-17-recursion-layered-failure-recovery-design.md`
- Modify: `docs/superpowers/plans/2026-07-17-recursion-layered-failure-recovery.md`

**Interfaces:**
- Documents the exact production behavior proven by Tasks 1-6.
- Produces final repo, Playwright, and installed-copy evidence.

- [ ] **Step 1: Update canonical documentation**

Replace tooltip-only reason guidance with visible reason sublines. Document
`RecursionFailure`, strict-then-repair parsing, Redirect reference diagnostics,
writer/verifier call budgets, and journal invariants.

- [ ] **Step 2: Run formatting and contract checks**

Run:

```powershell
git diff --check
rg -n "TBD|TODO|PLACEHOLDER" DESIGN.md docs src tools/scripts
```

Expected: no whitespace errors or unfinished contract language introduced by
this work.

- [ ] **Step 3: Run all focused suites**

Run:

```powershell
node tools/scripts/test-failures.mjs
node tools/scripts/test-provider-response-parser.mjs
node tools/scripts/test-providers.mjs
node tools/scripts/test-editorial-transform.mjs
node tools/scripts/test-editorial-runtime.mjs
node tools/scripts/test-progress.mjs
node tools/scripts/test-ui.mjs
node tools/scripts/test-live-enhancement-run-oracle.mjs
```

Expected: all PASS.

- [ ] **Step 4: Run the full suite**

Run:

```powershell
npm.cmd test
```

Expected: every registered test script passes with exit code 0.

- [ ] **Step 5: Install to the dedicated soak account**

Run the existing `robocopy` deployment into
`data/recursion-soak-a/extensions/Recursion`, excluding `.git`, `node_modules`,
tests, artifacts, and temporary files. Confirm the served copy hashes match the
repo.

- [ ] **Step 6: Run Playwright visual and negative-control proofs**

Run:

```powershell
node tools/scripts/prove-editorial-transformation-ui.mjs
node tools/scripts/prove-live-enhancements.mjs --user recursion-soak-a --mode redirect
```

Expected: visual matrix shows wrapped visible red/amber reasons; strict live
oracle reports no unhealthy transition for success and nonzero for injected
failure.

- [ ] **Step 7: Run real-provider SG-1-shaped Redirect certification**

Use `recursion-soak-a`, the actual configured providers, and a copied
SG-1-shaped scenario. Confirm:

- malformed syntax recovery, if exercised, records `local-json-repair`;
- diagnosis, candidate, verifier, and prompt-ready nodes settle healthy;
- exactly one Recursion-owned swipe is appended and selected;
- no unmatched provider calls or hidden warning/error journal entries;
- final candidate materially performs the Redirect objective.

- [ ] **Step 8: Update `default-user` only after certification**

Copy the exact verified repo state into the installed and public
`default-user` Recursion extension paths. Compare all production file hashes.
Do not run automated generation in `default-user`.

- [ ] **Step 9: Commit documentation and plan completion**

```powershell
git add DESIGN.md docs/design/UI_SPEC.md docs/architecture/PROVIDER_AND_GENERATION_SPEC.md docs/architecture/STORAGE_AND_DIAGNOSTICS.md docs/superpowers/specs/2026-07-17-recursion-layered-failure-recovery-design.md docs/superpowers/plans/2026-07-17-recursion-layered-failure-recovery.md
git commit -m "docs: finalize failure recovery contract"
```
