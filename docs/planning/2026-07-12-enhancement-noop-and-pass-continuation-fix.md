# Enhancement No-Op and Pass Continuation Fix

> **Superseded design:** use [Generation Review and Enhancement Contract](../architecture/ENHANCEMENT_REVIEW_AND_PATCH_CONTRACT.md) for new implementation. This document records the prior two-full-message-pass repair approach and must not be used as the implementation authority.

## Purpose

This document defines the fix for Recursion Enhancements that return unchanged text, incorrectly report failure, or prevent a separately selected pass from running.

The current failure is visible in the `prose-dialogue` path:

1. Dialogue runs.
2. Dialogue returns the original text.
3. Dialogue retries once.
4. The retry is also unchanged.
5. Runtime marks Dialogue as failed and marks Prose as `not-run`.

That behavior violates the user contract. A selected Prose pass must run unless it is explicitly canceled, unavailable, or unsafe to continue. A provider returning no safe change is not the same as a provider failure.

This document covers:

- the Enhancement result contract;
- no-op classification;
- independent Dialogue and Prose execution;
- prompt and validation changes;
- duplicate-swipe protection;
- progress and journal integration;
- tests and live validation.

Swipe card-cache reuse is a separate runtime concern. It should be implemented alongside this work only if the change set explicitly includes the swipe-reuse fix; this document does not redefine that cache contract.

## Current Boundaries

The primary seams are:

- `src/dialogue-enhancement.mjs`
- `src/prose-enhancement.mjs`
- `src/runtime.mjs`
- `src/progress.mjs`
- `src/ui/view-model.mjs`
- `tools/scripts/test-dialogue-enhancement.mjs`
- `tools/scripts/test-prose-enhancement.mjs`
- `tools/scripts/test-runtime.mjs`
- `tools/scripts/test-ui.mjs`

The provider schemas remain:

```js
recursion.dialogueEnhancer.v1
recursion.proseEnhancer.v1
```

The host mutation contract remains unchanged:

- `replace` replaces the current assistant text;
- `as-swipe` preserves the original and appends/selects an enhanced swipe;
- an identical enhanced swipe must never be created.

## Design Contract

Each selected pass returns one of four typed outcomes:

| Outcome | Meaning | Continue later pass? | Overall severity |
| --- | --- | --- | --- |
| `applied` | Valid changed text was accepted | Yes | Success |
| `unchanged` | Provider completed, but no safe useful change was available | Yes | Neutral success |
| `provider-failed` | Provider call failed or returned no usable provider result | Yes, using the last safe text | Failure for that pass |
| `validation-failed` | Provider returned data that violated the pass contract | Yes, using the last safe text | Failure for that pass |

`unchanged` must not be represented as `failed`, `warning`, or `not-run`.

The text pipeline is transactional per pass:

```text
safeText = original assistant text

Dialogue:
  applied          -> safeText = dialogue text
  unchanged        -> safeText remains original
  provider-failed  -> safeText remains original
  validation-failed -> safeText remains original

Prose:
  always receives safeText when Prose is selected
```

This means a failed or unchanged Dialogue pass cannot suppress Prose, and a failed Prose pass cannot damage the original assistant message.

## Step 1: Introduce Typed Pass Results

### Integration direction

Add a small internal result normalizer in `src/runtime.mjs` or a shared enhancement helper. It must preserve the existing provider result and validation details while making the control-flow outcome explicit.

```js
const ENHANCEMENT_PASS_OUTCOMES = new Set([
  'applied',
  'unchanged',
  'provider-failed',
  'validation-failed'
]);

function enhancementPassResult({
  pass,
  outcome,
  text,
  originalText,
  attempt = 1,
  reasonCode = '',
  reason = '',
  generation = null,
  validation = null
} = {}) {
  const normalizedOutcome = ENHANCEMENT_PASS_OUTCOMES.has(outcome)
    ? outcome
    : 'validation-failed';
  const changed = normalizedOutcome === 'applied'
    && String(text ?? '') !== String(originalText ?? '');

  return {
    pass: String(pass || ''),
    outcome: changed ? 'applied' : (normalizedOutcome === 'applied' ? 'unchanged' : normalizedOutcome),
    text: changed ? String(text ?? '') : String(originalText ?? ''),
    attempt,
    ...(reasonCode ? { reasonCode } : {}),
    ...(reason ? { reason } : {}),
    ...(generation?.lane ? { lane: generation.lane } : {}),
    ...(validation?.editRatio !== undefined ? { editRatio: validation.editRatio } : {})
  };
}
```

The `changed` check belongs in the runtime result boundary. A provider cannot claim success merely by returning a schema-valid copy of the input.

### Why this boundary matters

- Provider errors remain diagnosable.
- Validation errors remain safety failures.
- No-op output becomes an intentional, user-visible result.
- The pass loop no longer needs to infer control flow from exception-like validation errors.

## Step 2: Make No-Op a Valid Result

### Prose validation

Keep the structural safety checks in `validateProseEnhancementResult`:

- correct schema;
- non-empty text;
- maximum output size;
- dialogue structure preserved;
- protected dialogue unchanged except approved banned-slop cleanup.

Change exact no-op handling from a validation failure to a valid no-op result:

```js
export function validateProseEnhancementResult(result = {}, { originalText = '' } = {}) {
  const data = result && typeof result === 'object' ? result : {};
  if (data.schema !== PROSE_ENHANCER_SCHEMA) {
    return validationError('RECURSION_PROSE_SCHEMA_MISMATCH', 'Prose enhancement returned the wrong schema.');
  }

  const text = String(data.text ?? '');
  if (!text.trim()) return validationError('RECURSION_PROSE_EMPTY', 'Prose enhancement returned empty text.');
  if (text.length > MAX_TARGET_TEXT) {
    return validationError('RECURSION_PROSE_EXPANDED', 'Prose enhancement expanded the message too much.');
  }

  const structural = validateProtectedDialogue(originalText, text);
  if (!structural.ok) return structural;

  if (text === String(originalText ?? '')) {
    return {
      ok: true,
      outcome: 'unchanged',
      text,
      reasonCode: proseInterventionReasons(originalText).length
        ? 'no-safe-change-after-provider-attempt'
        : 'already-acceptable',
      editRatio: 0
    };
  }

  return {
    ok: true,
    outcome: 'applied',
    text,
    editRatio: roundedEnhancementEditRatio(originalText, text)
  };
}
```

`validateProtectedDialogue` represents the existing dialogue-preservation checks. It should be extracted only if that reduces duplication; the safety behavior must not be weakened.

### Dialogue validation

Apply the same distinction to Dialogue. If there are no detected intervention targets and the provider returns the original text, return `outcome: 'unchanged'` rather than `RECURSION_DIALOGUE_EXACT_NOOP`.

If an intervention target is detected and the provider returns the original text after the allowed retry, return:

```js
{
  ok: true,
  outcome: 'unchanged',
  text: originalText,
  reasonCode: 'detected-issue-no-safe-revision'
}
```

This preserves the diagnostic fact that an issue was detected without falsely claiming that the provider call failed.

## Step 3: Remove the Mandatory Edit-Ratio Success Gate

The current prompts request a 10% minimum edit and a 10-20% target. This creates pressure to alter text even when the only safe choice is to preserve it.

Replace the policy with:

```text
Make meaningful, minimal changes when a safe improvement exists.
Do not change text merely to reach a percentage target.
If no safe improvement is available, return the source unchanged and mark the result no_safe_change.
Never invent facts, actions, decisions, motives, names, or outcomes to create differences.
```

The runtime may continue to record edit ratios for observability, but an edit ratio below 10% must not automatically fail a structurally valid result.

Keep the soft maximum and structural limits. A large or unsafe rewrite remains a validation failure.

## Step 4: Make Dialogue and Prose Independent

### Current failure

`src/runtime.mjs` currently calls `appendSkippedEnhancementPasses(...)` and returns from the whole enhancement run when Dialogue is unchanged or fails validation. That is the direct cause of Prose being marked `not-run`.

### Replacement control flow

Use the last safe text as the input to each pass and continue through the selected sequence:

```js
let safeText = originalText;

for (const pass of passSequence) {
  const passInput = safeText;
  const result = pass === 'dialogue'
    ? await executeDialoguePass(passInput)
    : await executeProsePass(passInput);

  passResults.push(result);

  if (result.outcome === 'applied') {
    safeText = result.text;
  }

  if (result.outcome === 'unchanged') {
    // Preserve safeText and continue to the next selected pass.
    continue;
  }

  if (result.outcome === 'provider-failed' || result.outcome === 'validation-failed') {
    // Preserve safeText and continue independent passes.
    continue;
  }
}

enhancedText = safeText;
```

The pass runner should only return early for:

- cancellation;
- missing assistant message;
- host mutation failure that makes applying the result unsafe.

Provider or validation failure in one Enhancement pass must not prevent an independently selected later pass from receiving the last safe text.

### Pass-specific fallback

For `prose-dialogue`:

```js
const dialogueResult = await executeDialoguePass(originalText);
const proseInput = dialogueResult.outcome === 'applied'
  ? dialogueResult.text
  : originalText;
const proseResult = await executeProsePass(proseInput);
```

This makes the fallback explicit and prevents a partially invalid Dialogue result from entering Prose.

## Step 5: Prevent Identical Enhanced Swipes

No-op passes must not create a duplicate swipe.

Before `appendAssistantMessageSwipe`, compare the final text with the source text:

```js
const finalText = String(enhancedText ?? '');
const sourceText = String(originalText ?? '');
const changed = finalText !== sourceText;

if (!changed) {
  settleRuntimeActivity({
    runId,
    phase: 'settled',
    severity: 'success',
    label: 'Enhancement complete. No safe changes found.',
    chips: target === 'prose-dialogue' ? ['Dialogue', 'Prose'] : [target],
    detail: { passResults, outcome: 'unchanged' }
  });

  return {
    ok: true,
    unchanged: true,
    target,
    mode,
    messageId,
    originalHash,
    enhancedHash: originalHash,
    passResults
  };
}
```

This must happen before both `replaceAssistantMessageText` and `appendAssistantMessageSwipe`. An unchanged `as-swipe` result should retain the original selected swipe and report the reason rather than creating a visually identical branch.

## Step 6: Journal and Progress Integration

### Journal event shape

Each selected pass must produce a terminal journal entry:

```js
await appendEnhancementPassJournal({
  pass: 'prose',
  status: result.outcome,
  reasonCode: result.reasonCode,
  reason: result.reason,
  attempt: result.attempt
});
```

Recommended status values:

- `applied`
- `unchanged`
- `provider-failed`
- `validation-failed`
- `not-run` only when the user did not select the pass or cancellation occurred before it started

`not-run: previous-pass-failed` must be removed from the independent Dialogue/Prose path.

### Visible progress

Progress should distinguish no-op from failure:

```js
const ENHANCEMENT_PROGRESS = Object.freeze({
  applied: { severity: 'success', label: 'Enhancement applied.' },
  unchanged: { severity: 'success', label: 'No safe changes found.' },
  'provider-failed': { severity: 'error', label: 'Enhancement provider failed.' },
  'validation-failed': { severity: 'error', label: 'Enhancement output rejected.' }
});
```

The main Recursion status bar should show the pass-specific detail. The dropdown may show the same rows, but it must not downgrade a completed no-op to a caution or failure.

Examples:

```text
Dialogue Enhancement        no safe changes found
Prose Enhancement           applied
Enhancement                  done
```

or:

```text
Dialogue Enhancement        provider failed: timeout
Prose Enhancement           applied
Enhancement                  done with one pass failed
```

The final status can be success-with-detail when at least one selected pass applied and another failed. It must not claim that all selected passes succeeded.

## Step 7: Provider Prompt Integration

Update both Enhancement prompts so the provider understands the outcome contract.

Add to the structured response contract:

```json
{
  "schema": "recursion.proseEnhancer.v1",
  "text": "full assistant message",
  "outcome": "applied | no_safe_change",
  "changePlan": ["brief optional reason" ]
}
```

The runtime remains authoritative. It must recalculate whether the text actually changed and must not trust `outcome: applied` when the returned text equals the input.

Provider instructions should say:

```text
Return applied when you made a safe, meaningful revision.
Return no_safe_change when preserving the source is safer than inventing or damaging content.
Do not force a percentage of edits.
```

If changing the provider schema is too broad for the current release, keep `outcome` internal and infer it from the text comparison. The explicit field is preferable because it improves diagnostics, but it is not a substitute for runtime comparison.

## Step 8: Testing Plan

### Contract tests

Add tests for both validators:

```js
const unchanged = validateProseEnhancementResult({
  schema: PROSE_ENHANCER_SCHEMA,
  text: originalText
}, { originalText });

assertEqual(unchanged.ok, true, 'clean prose no-op is valid');
assertEqual(unchanged.outcome, 'unchanged', 'clean prose no-op is classified explicitly');
```

Cover:

- clean prose unchanged;
- detected slop unchanged after retry;
- changed prose with preserved dialogue;
- changed dialogue structure rejected;
- empty output rejected;
- oversized output rejected;
- dialogue no-op with Prose selected;
- Dialogue provider failure with Prose selected;
- Dialogue validation failure with Prose selected.

### Runtime pass-sequence tests

Use a recording generation router:

```js
const calls = [];
const generationRouter = {
  async generate(roleId) {
    calls.push(roleId);
    if (roleId === 'dialogueEnhancer') {
      return { ok: true, data: { schema: 'recursion.dialogueEnhancer.v1', text: originalText } };
    }
    if (roleId === 'proseEnhancer') {
      return { ok: true, data: { schema: 'recursion.proseEnhancer.v1', text: revisedText } };
    }
    throw new Error(`Unexpected role: ${roleId}`);
  }
};

assertDeepEqual(calls, ['dialogueEnhancer', 'proseEnhancer'], 'Prose runs after Dialogue no-op');
```

Also assert:

- no identical swipe is appended;
- an applied Prose result is appended once;
- a failed Dialogue result does not suppress Prose;
- the final text comes from the last applied safe pass;
- `passResults` contains a terminal result for every selected pass.

### UI tests

Verify the progress model renders:

- `unchanged` as a completed neutral-success state;
- provider and validation failures as explicit failures;
- no `not-run` Prose row after a Dialogue no-op;
- pass-specific reason text in the main status area;
- no false all-success summary when one pass failed.

### Live Playwright validation

Run against a dedicated SillyTavern user and the actual served extension:

1. Enable `Prose + Dialogue` and `As Swipe`.
2. Generate a response with dialogue that needs no safe repair but narration that can be improved.
3. Watch the progress dropdown.
4. Confirm both provider calls occur in order.
5. Confirm Dialogue reports `unchanged`, not failure.
6. Confirm Prose reports `applied` or an explicit independent result.
7. Confirm a changed enhanced swipe exists only when final text differs.
8. Repeat with both passes producing unchanged output and confirm no duplicate swipe is created.
9. Repeat with a simulated Dialogue provider failure and confirm Prose still runs.

The live report should include sanitized pass outcomes, provider-call role order, original/final text hashes, swipe count before and after, and the served extension file hashes.

## Implementation Order

1. Add validator tests for explicit `unchanged` outcomes.
2. Add runtime pass-result normalization tests.
3. Change Dialogue and Prose validators to return valid no-op results.
4. Remove early returns that skip independent passes.
5. Add safe-text fallback sequencing.
6. Add identical-output protection before host mutation.
7. Update journal and progress status mappings.
8. Update provider prompts and schemas if the explicit outcome field is adopted.
9. Run focused tests, then `npm.cmd test`.
10. Sync the served extension and run the live Playwright matrix.

## Acceptance Criteria

The fix is complete when:

- a clean Dialogue no-op does not fail the Enhancement run;
- a Dialogue no-op never prevents selected Prose from running;
- a Dialogue provider or validation failure does not prevent selected Prose from running;
- Prose may report no safe change without being treated as a provider failure;
- no identical enhanced swipe is created;
- every selected pass has an explicit terminal status;
- the main Recursion status area explains the exact pass outcome;
- live SG-1-style generation proves the call order and final swipe behavior.
