# Readable Failure Presentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Recursion warning and failure show a plain-language reason at the correct progress stage, with an optional visible next action, while retaining stable diagnostic codes outside the ordinary progress copy.

**Architecture:** Complete the existing normalized `detail.failure` contract at producer boundaries. `src/failures.mjs` owns display-safe classification, `src/activity.mjs` enforces the descriptor invariant, `src/runtime.mjs` supplies the descriptor and terminal logical stage, `src/progress.mjs` routes and preserves failure presentation data, and `src/ui.mjs` renders the reason/action without reclassifying errors.

**Tech Stack:** Browser-native ECMAScript modules, Node-based script tests, SillyTavern extension runtime, DOM rendering in `src/ui.mjs`, CSS in `styles/recursion.css`.

## Global Constraints

- Recursion is pre-alpha: update all unhealthy activity producers to one V1 contract; do not add a compatibility shim for `detail.message`.
- Warning/error activity uses `detail.failure`; UI code must not classify raw exceptions.
- Internal `RECURSION_*` codes remain available in diagnostics but do not appear in ordinary progress reason/action text.
- Failure copy is bounded, sanitized, calm, specific, and does not invent environmental causes.
- Cancellation, supersession, skip, success, cached, and successful retry semantics remain unchanged.
- Warning and failed progress rows show their reason without hover.
- A meaningful `suggestedAction` is visible as `Try:`; absent actions create no empty row space.
- No raw prompts, provider output, hidden reasoning, credentials, stack traces, filesystem paths, or unbounded provider text enter compact UI copy.
- Use the existing compact graphite progress menu; do not add toast, modal, banner, or dashboard surfaces.
- Preserve the current provider retry and routing behavior.
- Full verification is `npm.cmd test` plus the completion audit in this plan.

---

## File Map

- `src/failures.mjs`: normalized failure construction, provider classification, safe thrown-error conversion, and canonical user copy.
- `src/activity.mjs`: defense-in-depth enforcement that every unhealthy event contains a failure descriptor.
- `src/runtime.mjs`: capture the active logical stage and settle failures with `detail.failure`.
- `src/progress.mjs`: route unhealthy generic settlements to their real stage and preserve `suggestedAction`/`failureCode`.
- `src/ui.mjs`: render the visible reason and optional action; include both in tooltip/accessibility text.
- `styles/recursion.css`: compact action-line geometry and state-safe colors.
- `tools/scripts/test-failures.mjs`: failure copy, classification, bounds, and redaction tests.
- `tools/scripts/test-activity.mjs`: unhealthy activity invariant tests.
- `tools/scripts/test-runtime.mjs`: terminal runtime propagation and stage capture tests.
- `tools/scripts/test-progress.mjs`: terminal routing and normalized step tests.
- `tools/scripts/test-ui.mjs`: visible explanation/action and diagnostic-code exclusion tests.
- `tools/scripts/lib/failure-presentation-oracle.mjs`: cross-layer invariant used by focused and live tests.
- `tools/scripts/test-failure-presentation-oracle.mjs`: deterministic oracle tests.
- `DESIGN.md`, `docs/design/UI_SPEC.md`, `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`, `docs/architecture/STORAGE_AND_DIAGNOSTICS.md`: final public contracts.

---

### Task 1: Normalize thrown failures into layman-safe descriptors

**Files:**
- Modify: `src/failures.mjs`
- Modify: `tools/scripts/test-failures.mjs`

**Interfaces:**
- Consumes: existing `createFailure(input)`, `providerFailure(error, context)`, `failureFrom(value, fallback)`.
- Produces: `failureFromError(error, context)` returning the existing frozen failure descriptor shape.

- [ ] **Step 1: Extend the failure tests with the intended user copy**

Update the import in `tools/scripts/test-failures.mjs`:

```js
import {
  createFailure,
  failureFrom,
  failureFromError,
  failureReason,
  providerFailure
} from '../../src/failures.mjs';
```

Replace the old generic assertion and add thrown-error/provider fallback cases:

```js
const generic = failureFrom('Action failed.');
assertEqual(generic.code, 'RECURSION_INTERNAL', 'generic failure uses internal code');
assertEqual(generic.category, 'internal', 'generic failure uses internal category');
assertEqual(generic.message, 'Recursion hit an unexpected internal error.', 'generic failure uses readable copy');
assert(!generic.message.includes(generic.code), 'generic user copy excludes the internal code');
assertEqual(failureReason(generic), generic.message, 'failureReason returns normalized message');

const thrownTimeout = failureFromError(
  Object.assign(new Error('Provider generation timed out after 120000ms.'), {
    code: 'RECURSION_PROVIDER_TIMEOUT'
  }),
  { stage: 'utility-card-batch' }
);
assertEqual(thrownTimeout.code, 'RECURSION_PROVIDER_TIMEOUT', 'thrown timeout keeps stable code');
assertEqual(thrownTimeout.category, 'provider-timeout', 'thrown timeout is provider timeout');
assertEqual(
  thrownTimeout.message,
  'The selected model connection did not respond before the time limit.',
  'thrown timeout uses layman-safe copy'
);
assertEqual(
  thrownTimeout.suggestedAction,
  'Check the selected connection profile, then try again.',
  'thrown timeout gives a concrete next action'
);
assert(!thrownTimeout.message.includes('120000'), 'timeout UI copy excludes milliseconds');

const thrownInternal = failureFromError(
  Object.assign(new Error('C:\\private\\runtime\\packet.mjs:93 secret-value'), {
    code: 'RECURSION_PACKET_INTERNAL'
  }),
  { stage: 'utility-composing' }
);
assertEqual(thrownInternal.code, 'RECURSION_PACKET_INTERNAL', 'internal failure keeps diagnostic code');
assertEqual(thrownInternal.category, 'internal', 'unknown thrown error remains internal');
assertEqual(thrownInternal.message, 'Recursion hit an unexpected internal error.', 'unknown thrown error hides technical text');
assert(!JSON.stringify(thrownInternal).includes('C:\\private'), 'unknown failure excludes filesystem path');
assert(!JSON.stringify(thrownInternal).includes('secret-value'), 'unknown failure excludes raw exception secret');

const unknownProvider = providerFailure(
  { code: 'RECURSION_PROVIDER_REMOTE_FAILURE', message: 'Remote adapter failed.' },
  { stage: 'provider-call' }
);
assertEqual(
  unknownProvider.message,
  'The selected model connection could not complete the request.',
  'unknown provider failure remains readable'
);
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```powershell
node tools/scripts/test-failures.mjs
```

Expected: FAIL because `failureFromError` is not exported and the old generic/provider fallback copy differs.

- [ ] **Step 3: Implement safe generic copy and thrown-error classification**

In `src/failures.mjs`, replace `normalizedMessage` and add the provider-shape predicate:

```js
const INTERNAL_FAILURE_MESSAGE = 'Recursion hit an unexpected internal error.';
const INTERNAL_FAILURE_ACTION = 'Try again. If it keeps happening, copy the failure code from Diagnostics.';

function normalizedMessage(value) {
  const message = compact(redact(value), 300);
  const generic = message.toLowerCase().replace(/[.!]+$/g, '');
  if (!message || GENERIC_MESSAGES.has(generic)) return INTERNAL_FAILURE_MESSAGE;
  return message;
}

function looksLikeProviderFailure(error = {}) {
  const code = errorCode(error);
  const status = errorStatus(error);
  const message = String(error?.message || error || '').toLowerCase();
  return status >= 400
    || code.startsWith('RECURSION_PROVIDER_')
    || code.startsWith('RECURSION_JSON_')
    || /timed?\s*out|timeout|rate limit|context length|finish_reason.?length/.test(message);
}
```

Update timeout and unknown-provider branches in `providerFailure`:

```js
if (code === 'RECURSION_PROVIDER_TIMEOUT' || /timed?\s*out|timeout/.test(lower)) {
  return createFailure({
    code: 'RECURSION_PROVIDER_TIMEOUT',
    stage,
    category: 'provider-timeout',
    message: 'The selected model connection did not respond before the time limit.',
    retryable: true,
    suggestedAction: 'Check the selected connection profile, then try again.'
  });
}

return createFailure({
  code,
  stage,
  category: 'provider-request',
  message: 'The selected model connection could not complete the request.',
  retryable: error?.retryable === true,
  suggestedAction: error?.retryable === true ? 'Try again.' : ''
});
```

Add the new exported boundary before `failureReason`:

```js
export function failureFromError(error = {}, context = {}) {
  const stage = context.stage || 'runtime';
  if (looksLikeProviderFailure(error)) return providerFailure(error, { stage });
  return createFailure({
    code: error?.code || error?.name || 'RECURSION_INTERNAL',
    stage,
    category: context.category || 'internal',
    message: INTERNAL_FAILURE_MESSAGE,
    retryable: false,
    suggestedAction: INTERNAL_FAILURE_ACTION
  });
}
```

Keep `createFailure` calling `normalizedMessage(source.message)`; the now-unused `code` argument is removed.

- [ ] **Step 4: Run the focused tests**

Run:

```powershell
node tools/scripts/test-failures.mjs
npm.cmd run test:providers
```

Expected: both commands PASS. Existing provider assertions that intentionally check older wording must be updated only where the design changes canonical visible copy.

- [ ] **Step 5: Commit Task 1**

```powershell
git add src/failures.mjs tools/scripts/test-failures.mjs
git commit -m "fix: make normalized failures readable"
```

---

### Task 2: Enforce a friendly unhealthy-activity invariant

**Files:**
- Modify: `src/activity.mjs`
- Modify: `tools/scripts/test-activity.mjs`

**Interfaces:**
- Consumes: `failureFrom(value, fallback)` and the canonical internal fallback from Task 1.
- Produces: every normalized warning/error activity contains `detail.failure`; legacy `detail.message` remains non-authoritative.

- [ ] **Step 1: Change activity tests to require friendly fallback copy**

Replace the two existing missing-reason expectations and add a legacy-shape regression:

```js
assertEqual(
  outcomes.find((event) => event.runId === 'warning-run' && event.phase === 'settled').detail.failure.message,
  'Recursion hit an unexpected internal error.',
  'warning settlement without a descriptor receives readable fallback copy'
);
assertEqual(
  outcomes.find((event) => event.runId === 'error-run' && event.phase === 'settled').detail.failure.message,
  'Recursion hit an unexpected internal error.',
  'error settlement without a descriptor receives readable fallback copy'
);
assertEqual(
  outcomes.find((event) => event.runId === 'error-run' && event.phase === 'settled').detail.failure.code,
  'RECURSION_ACTIVITY_REASON_MISSING',
  'missing descriptor retains its diagnostic sentinel code'
);

const legacyRun = outcomeReporter.start({ runId: 'legacy-message-run', label: 'Legacy run' });
outcomeReporter.settle({
  runId: legacyRun.runId,
  outcome: 'error',
  logicalStage: 'utilityComposing',
  label: 'Legacy error',
  detail: { message: 'Provider generation timed out after 120000ms.' }
});
const legacyEvent = outcomes.find((event) => event.runId === legacyRun.runId && event.phase === 'settled');
assertEqual(legacyEvent.detail.failure.code, 'RECURSION_ACTIVITY_REASON_MISSING', 'legacy detail.message is not a supported descriptor');
assertEqual(legacyEvent.detail.failure.stage, 'utilitycomposing', 'sentinel records the owning logical stage');
assertEqual(legacyEvent.detail.failure.message, 'Recursion hit an unexpected internal error.', 'legacy raw message is not promoted to UI copy');
assertEqual(legacyEvent.detail.message, undefined, 'legacy raw message is removed from unhealthy activity');
```

- [ ] **Step 2: Run the activity test to observe the old copy**

Run:

```powershell
npm.cmd run test:activity
```

Expected: FAIL because missing reasons still interpolate `RECURSION_ACTIVITY_REASON_MISSING` into their message.

- [ ] **Step 3: Give the invariant an explicit safe fallback**

Replace `ensureUnhealthyFailure` in `src/activity.mjs`:

```js
function ensureUnhealthyFailure(event) {
  if (!['warning', 'error'].includes(event.severity)) return event;
  const detail = event.detail && typeof event.detail === 'object' && !Array.isArray(event.detail)
    ? event.detail
    : {};
  const cause = detail.failure
    || detail.error
    || detail.compactError
    || detail.reason
    || detail.statusReason
    || detail.cautionReason
    || detail.decision
    || event.fallbackReason;
  const failure = failureFrom(cause, {
    code: 'RECURSION_ACTIVITY_REASON_MISSING',
    stage: event.logicalStage || event.phase || 'activity',
    category: 'internal',
    message: 'Recursion hit an unexpected internal error.',
    suggestedAction: 'Try again. If it keeps happening, copy the failure code from Diagnostics.'
  });
  const descriptorDetail = { ...detail };
  delete descriptorDetail.message;
  return {
    ...event,
    detail: cleanStructured({ ...descriptorDetail, failure }) ?? { failure }
  };
}
```

Do not add `detail.message` to `cause`.

- [ ] **Step 4: Run activity and failure tests**

```powershell
npm.cmd run test:activity
node tools/scripts/test-failures.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```powershell
git add src/activity.mjs tools/scripts/test-activity.mjs
git commit -m "fix: enforce readable activity failures"
```

---

### Task 3: Migrate runtime terminal catches to `detail.failure`

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-runtime.mjs`

**Interfaces:**
- Consumes: `failureFromError(error, { stage, category? })` from Task 1 and `safeCurrentActivity(activity)` in `src/runtime.mjs`.
- Produces: terminal runtime activity with `phase: 'settled'`, `logicalStage`, and `detail.failure`.

- [ ] **Step 1: Extend the existing snapshot-failure regression around the outer preparation catch**

Replace the existing `snapshot failed with Bearer crash-token` test block in
`tools/scripts/test-runtime.mjs` with this exact block:

```js
{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => {
      throw Object.assign(
        new Error('snapshot failed with Bearer crash-token, sk-crash-runtime, and private-secret'),
        { code: 'RECURSION_SNAPSHOT_FAILED' }
      );
    }
  });
  let caughtError = null;
  try {
    await runtime.prepareForGeneration({ userMessage: 'Crash safely.' });
  } catch (error) {
    caughtError = error;
  }
  const view = runtime.view();
  assert(caughtError, 'runtime failure still throws to caller');
  assertNoSecretText(caughtError?.message || caughtError, 'runtime thrown error');
  assertEqual(view.activity.phase, 'settled', 'runtime failure settles activity');
  assertEqual(view.activity.severity, 'error', 'runtime failure is error severity');
  assertEqual(view.activity.logicalStage, 'started', 'runtime failure captures active logical stage');
  assertEqual(view.activity.detail.failure.code, 'RECURSION_SNAPSHOT_FAILED', 'runtime keeps diagnostic code');
  assertEqual(view.activity.detail.failure.category, 'internal', 'unknown runtime exception stays internal');
  assertEqual(view.activity.detail.failure.message, 'Recursion hit an unexpected internal error.', 'runtime exposes readable internal copy');
  assertEqual(view.activity.detail.message, undefined, 'runtime no longer emits legacy detail.message');
  assertNoSecretText(view.activity.detail, 'runtime failure activity detail');
}
```

- [ ] **Step 2: Run the runtime test to verify the legacy shape fails**

```powershell
npm.cmd run test:runtime
```

Expected: FAIL because the catch emits `detail.message`, omits `logicalStage`, and activity replaces the reason with the missing-descriptor sentinel.

- [ ] **Step 3: Import the thrown-error normalizer**

Add near the other top-level imports in `src/runtime.mjs`:

```js
import { failureFromError } from './failures.mjs';
```

- [ ] **Step 4: Replace the main preparation catch settlement**

Replace the settlement in the main `prepareForGeneration` catch with:

```js
const activeActivity = safeCurrentActivity(activity);
const logicalStage = activeActivity?.phase || 'runtime';
const safeError = runtimeError(error);
const failure = failureFromError(error, { stage: logicalStage });

settleRuntimeActivity({
  runId,
  phase: 'settled',
  logicalStage,
  outcome: 'error',
  label: 'Recursion could not prepare the prompt.',
  detail: { failure }
});
```

- [ ] **Step 5: Replace the Rapid warm legacy detail**

Keep its existing saved warm-status work, then replace only its settlement with:

```js
const failure = failureFromError(error, { stage: 'rapid-warm' });
settleRuntimeActivity({
  runId,
  outcome: 'warning',
  phase: 'rapidWarmFailed',
  logicalStage: 'rapidWarmFailed',
  label: 'Rapid warm failed.',
  chips: ['Rapid'],
  detail: { failure }
});
```

Retain the existing `safeError`, `lastRapidWarmView`, `warmOutcome`, and
fail-soft return behavior around this replacement.

- [ ] **Step 6: Confirm no runtime unhealthy settlement keeps the legacy shape**

Run:

```powershell
rg -n "outcome:\s*'(warning|error)'|severity:\s*'(warning|error)'|detail:\s*\{\s*message" src/runtime.mjs
```

Expected: neither the Rapid warm catch nor the main preparation catch emits
`detail: { message: ... }`. Successful retry, cancellation, supersession, and
skipped settlements remain unchanged.

- [ ] **Step 7: Run focused runtime gates**

```powershell
npm.cmd run test:runtime
npm.cmd run test:activity
npm.cmd run test:providers
```

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

```powershell
git add src/runtime.mjs tools/scripts/test-runtime.mjs
git commit -m "fix: propagate runtime failure descriptors"
```

---

### Task 4: Route failed settlements to the actual progress stage

**Files:**
- Modify: `src/progress.mjs`
- Modify: `tools/scripts/test-progress.mjs`

**Interfaces:**
- Consumes: activity `logicalStage` and `detail.failure` from Tasks 2-3.
- Produces: normalized steps with `reason`, `suggestedAction`, and `failureCode`; failed generic settlements never map to `recursion-prompt-ready`.

- [ ] **Step 1: Add the reported-sequence regression test**

Append to `tools/scripts/test-progress.mjs` before its final pass log:

```js
const readableTerminalFailure = createProgressRunModel({
  activityHistory: [
    { runId: 'readable-failure', phase: 'started', label: 'Reading current turn...', recordedAt: '1' },
    { runId: 'readable-failure', phase: 'arbiterPlanning', label: 'Planning card pass...', recordedAt: '2' },
    { runId: 'readable-failure', phase: 'cardBatchRunning', label: 'Utility card batch...', recordedAt: '3' },
    {
      runId: 'readable-failure',
      phase: 'settled',
      logicalStage: 'utilityComposing',
      severity: 'error',
      outcome: 'error',
      label: 'Recursion could not prepare the prompt.',
      detail: {
        failure: {
          code: 'RECURSION_PROVIDER_TIMEOUT',
          stage: 'utility-composing',
          category: 'provider-timeout',
          message: 'The selected model connection did not respond before the time limit.',
          retryable: true,
          suggestedAction: 'Check the selected connection profile, then try again.'
        }
      },
      recordedAt: '4'
    }
  ],
  activity: {
    runId: 'readable-failure',
    phase: 'settled',
    logicalStage: 'utilityComposing',
    severity: 'error',
    outcome: 'error',
    label: 'Recursion could not prepare the prompt.',
    detail: {
      failure: {
        code: 'RECURSION_PROVIDER_TIMEOUT',
        stage: 'utility-composing',
        category: 'provider-timeout',
        message: 'The selected model connection did not respond before the time limit.',
        retryable: true,
        suggestedAction: 'Check the selected connection profile, then try again.'
      }
    },
    recordedAt: '4'
  }
});

const readableFailedStep = readableTerminalFailure.steps.find((step) => step.id === 'composing-prompt-packet');
assert(readableFailedStep, 'failed settlement maps to its logical compose stage');
assertEqual(readableFailedStep.state, 'failed', 'logical compose stage is failed');
assertEqual(
  readableFailedStep.reason,
  'The selected model connection did not respond before the time limit.',
  'failed stage keeps readable reason'
);
assertEqual(
  readableFailedStep.suggestedAction,
  'Check the selected connection profile, then try again.',
  'failed stage keeps suggested action'
);
assertEqual(readableFailedStep.failureCode, 'RECURSION_PROVIDER_TIMEOUT', 'failed stage keeps diagnostic code');
assert(
  !readableTerminalFailure.steps.some((step) => step.id === 'recursion-prompt-ready' && step.state === 'failed'),
  'failed generic settlement never becomes prompt ready'
);
assert(!readableTerminalFailure.currentStepText.includes('RECURSION_'), 'compact status excludes internal code');
```

Add the unknown-stage fallback case:

```js
const unknownStageFailure = createProgressRunModel({
  activityHistory: [{
    runId: 'unknown-stage-failure',
    phase: 'settled',
    logicalStage: 'unknownStage',
    severity: 'error',
    outcome: 'error',
    detail: { failure: {
      code: 'RECURSION_INTERNAL',
      stage: 'runtime',
      category: 'internal',
      message: 'Recursion hit an unexpected internal error.',
      retryable: false
    } },
    recordedAt: '1'
  }],
  activity: {
    runId: 'unknown-stage-failure',
    phase: 'settled',
    logicalStage: 'unknownStage',
    severity: 'error',
    outcome: 'error',
    detail: { failure: {
      code: 'RECURSION_INTERNAL',
      stage: 'runtime',
      category: 'internal',
      message: 'Recursion hit an unexpected internal error.',
      retryable: false
    } },
    recordedAt: '1'
  }
});
const runtimeFallbackStep = unknownStageFailure.steps.find((step) => step.id === 'recursion-runtime');
assert(runtimeFallbackStep, 'unknown logical stage creates runtime fallback step');
assertEqual(runtimeFallbackStep.label, 'Preparing Recursion response', 'runtime fallback has readable label');
assertEqual(runtimeFallbackStep.state, 'failed', 'runtime fallback step is failed');
```

- [ ] **Step 2: Run the progress test to verify failure**

```powershell
node tools/scripts/test-progress.mjs
```

Expected: FAIL because the terminal event maps to `recursion-prompt-ready` and the normalized step drops `suggestedAction`/`failureCode`.

- [ ] **Step 3: Add the fallback progress step**

In `STEP_ORDER`, insert `recursion-runtime` immediately before
`recursion-prompt-ready`. In `STEP_DEFINITIONS`, add:

```js
'recursion-runtime': {
  label: 'Preparing Recursion response',
  providerLane: 'utility'
},
```

- [ ] **Step 4: Route unhealthy generic settlements before success routing**

Add helpers before `eventStepId`:

```js
function eventFailure(event) {
  return asObject(asObject(asObject(event).detail).failure);
}

function eventIsUnhealthy(event) {
  const severity = cleanText(event?.severity).toLowerCase();
  const outcome = cleanText(event?.outcome).toLowerCase();
  return severity === 'warning'
    || severity === 'error'
    || outcome === 'warning'
    || outcome === 'error';
}
```

Insert into `eventStepId` after the specialized post-process/editorial cases and before the generic provider/phase mapping:

```js
if (phase === 'settled' && eventIsUnhealthy(event)) {
  const logicalStage = cleanText(event.logicalStage);
  return PHASE_STEP_IDS[logicalStage] || 'recursion-runtime';
}
```

The existing final `return PHASE_STEP_IDS[phase] || null` continues to map a
successful normal settlement to `recursion-prompt-ready`.

- [ ] **Step 5: Preserve action and diagnostic code in normalized steps**

Add bounded extractors:

```js
function eventSuggestedAction(event) {
  return safeDisplayText(eventFailure(event).suggestedAction, '', 180);
}

function eventFailureCode(event) {
  return safeDisplayText(eventFailure(event).code, '', 120)
    .replace(/[^A-Z0-9_]+/gi, '_')
    .toUpperCase();
}

function applyEventFailureToChildren(value, event) {
  const suggestedAction = eventSuggestedAction(event);
  const failureCode = eventFailureCode(event);
  const decorate = (child) => {
    if (!child || !['warning', 'failed'].includes(cleanText(child.state).toLowerCase())) return child;
    return {
      ...child,
      suggestedAction: child.suggestedAction || suggestedAction || null,
      failureCode: child.failureCode || failureCode || null
    };
  };
  return Array.isArray(value) ? value.map(decorate) : decorate(value);
}
```

In `deriveProgressRun`, replace the child creation line and extend the step
passed to `normalizeStep`:

```js
const child = applyEventFailureToChildren(childStepFromEvent(event, state, eventOrder), event);
suggestedAction: eventSuggestedAction(event),
failureCode: eventFailureCode(event),
```

Add child aggregation helpers beside `aggregateReason`:

```js
function aggregateSuggestedAction(children = []) {
  const child = (Array.isArray(children) ? children : [])
    .find((entry) => ['failed', 'warning'].includes(entry?.state) && safeDisplayText(entry?.suggestedAction, '', 180));
  return safeDisplayText(child?.suggestedAction, '', 180);
}

function aggregateFailureCode(children = []) {
  const child = (Array.isArray(children) ? children : [])
    .find((entry) => ['failed', 'warning'].includes(entry?.state) && safeDisplayText(entry?.failureCode, '', 120));
  return safeDisplayText(child?.failureCode, '', 120);
}
```

Extend `normalizeChildStep` so child failure data survives its normalization
pass:

```js
suggestedAction: safeDisplayText(source.suggestedAction, '', 180) || null,
failureCode: safeDisplayText(source.failureCode, '', 120)
  .replace(/[^A-Z0-9_]+/gi, '_')
  .toUpperCase() || null,
```

Extend `normalizeStep`, preferring explicit parent data and then its material
child:

```js
suggestedAction: safeDisplayText(source.suggestedAction, '', 180)
  || aggregateSuggestedAction(children)
  || null,
failureCode: (safeDisplayText(source.failureCode, '', 120)
  || aggregateFailureCode(children))
  .replace(/[^A-Z0-9_]+/gi, '_')
  .toUpperCase()
  || null,
```

Extend `upsertStep` so material new failure data wins while older data remains
available when a later event omits it:

```js
next.suggestedAction = safeDisplayText(step.suggestedAction, '', 180)
  || safeDisplayText(existing.suggestedAction, '', 180)
  || aggregateSuggestedAction(next.children)
  || null;
next.failureCode = safeDisplayText(step.failureCode, '', 120)
  || safeDisplayText(existing.failureCode, '', 120)
  || aggregateFailureCode(next.children)
  || null;
```

- [ ] **Step 6: Run the progress and UI-model tests**

```powershell
node tools/scripts/test-progress.mjs
npm.cmd run test:ui
```

Expected: PASS. UI rendering has not changed yet, but its current step model remains compatible with the two new optional fields.

- [ ] **Step 7: Commit Task 4**

```powershell
git add src/progress.mjs tools/scripts/test-progress.mjs
git commit -m "fix: route failures to their progress stage"
```

---

### Task 5: Render the visible next action without exposing codes

**Files:**
- Modify: `src/ui.mjs`
- Modify: `styles/recursion.css`
- Modify: `tools/scripts/test-ui.mjs`

**Interfaces:**
- Consumes: optional `step.suggestedAction` and `step.failureCode` from Task 4.
- Produces: a visible `Try:` line for unhealthy rows; tooltips include reason/action; normal row text excludes `failureCode`.

- [ ] **Step 1: Add a UI regression for visible reason/action and hidden code**

Near the existing warning-row reason test in `tools/scripts/test-ui.mjs`, add:

```js
const timeoutReason = 'The selected model connection did not respond before the time limit.';
const timeoutAction = 'Check the selected connection profile, then try again.';
view = {
  ...view,
  activity: { phase: 'settled', severity: 'error', label: 'Recursion could not prepare the prompt.' },
  progressRun: {
    runId: 'ui-readable-failure',
    title: 'Issue',
    steps: [{
      id: 'composing-prompt-packet',
      label: 'Composing prompt packet',
      providerLane: 'utility',
      state: 'failed',
      reason: timeoutReason,
      suggestedAction: timeoutAction,
      failureCode: 'RECURSION_PROVIDER_TIMEOUT'
    }]
  }
};
ui.update();
const timeoutRow = root.querySelectorAll('[data-recursion-progress-row]')
  .find((row) => row.dataset.recursionProgressStepId === 'composing-prompt-packet');
assertEqual(timeoutRow.querySelector('[data-recursion-progress-reason]').textContent, timeoutReason, 'failed row shows readable reason');
assertEqual(timeoutRow.querySelector('[data-recursion-progress-action]').textContent, `Try: ${timeoutAction}`, 'failed row shows next action');
assert(timeoutRow.className.includes('has-action'), 'failed row expands for next action');
assert(timeoutRow.getAttribute('title').includes(`Reason: ${timeoutReason}`), 'tooltip repeats reason');
assert(timeoutRow.getAttribute('title').includes(`Try: ${timeoutAction}`), 'tooltip repeats action');
assert(!fakeDocument.textTree(timeoutRow).includes('RECURSION_PROVIDER_TIMEOUT'), 'ordinary row text hides diagnostic code');
```

Extend the subsequent routine-success case:

```js
assertEqual(
  routineProgressRow.querySelector('[data-recursion-progress-action]').textContent,
  '',
  'routine row omits action copy'
);
assert(!routineProgressRow.className.includes('has-action'), 'routine row keeps compact geometry');
```

- [ ] **Step 2: Run the UI test to verify the missing action element**

```powershell
npm.cmd run test:ui
```

Expected: FAIL because `[data-recursion-progress-action]` does not exist.

- [ ] **Step 3: Add the action node to each progress row**

In `createProgressRow`, add after the reason span:

```js
el('span', {
  className: 'recursion-step-action',
  text: step.suggestedAction ? `Try: ${step.suggestedAction}` : '',
  dataset: { recursionProgressAction: '' }
})
```

- [ ] **Step 4: Update row synchronization and tooltip copy**

In `progressStepTooltip`, add:

```js
const suggestedAction = cleanText(step.suggestedAction);
```

and add this item after the reason:

```js
suggestedAction ? `Try: ${suggestedAction}` : '',
```

In `updateProgressRow`, add:

```js
const suggestedAction = step.suggestedAction || '';
const unhealthy = ['warning', 'failed'].includes(state);
const visibleReason = reason && unhealthy ? reason : '';
const visibleAction = suggestedAction && unhealthy ? `Try: ${suggestedAction}` : '';
```

Include `row.dataset.recursionProgressAction !== suggestedAction` in the
`changed` expression, then set and render it:

```js
row.dataset.recursionProgressAction = suggestedAction;
setText(row, '[data-recursion-progress-action]', visibleAction);
if (visibleAction) addClassName(row, 'has-action');
else removeClassName(row, 'has-action');
```

Pass `suggestedAction` into `progressStepTooltip`. Do not pass or render
`failureCode`.

- [ ] **Step 5: Add compact action styling**

In `styles/recursion.css`, directly after `.recursion-step-reason` rules, add:

```css
.recursion-step-action {
  color: var(--SmartThemeEmColor, var(--recursion-muted));
  font-size: 10px;
  grid-column: 4 / -1;
  line-height: 1.25;
  min-width: 0;
  overflow-wrap: anywhere;
  padding: 0 0 2px;
}

.recursion-step-action:empty {
  display: none;
}

.recursion-step-row.has-action {
  height: auto;
}
```

Keep the existing amber/red reason colors. The action remains subdued rather than becoming a second error-colored headline.

- [ ] **Step 6: Run UI and progress tests**

```powershell
npm.cmd run test:ui
node tools/scripts/test-progress.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit Task 5**

```powershell
git add src/ui.mjs styles/recursion.css tools/scripts/test-ui.mjs
git commit -m "feat: show actionable failure guidance"
```

---

### Task 6: Add a cross-layer readable-failure oracle

**Files:**
- Create: `tools/scripts/lib/failure-presentation-oracle.mjs`
- Create: `tools/scripts/test-failure-presentation-oracle.mjs`

**Interfaces:**
- Consumes: `{ activityHistory, progressRun, renderedRows }` where rendered rows contain `{ label, state, reason, action, text }`.
- Produces: `assertEveryUnhealthyStateExplainsWhy(input)` that throws on contract violations and returns `{ ok: true }` when healthy.

- [ ] **Step 1: Write the oracle test**

Create `tools/scripts/test-failure-presentation-oracle.mjs`:

```js
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';
import { assertEveryUnhealthyStateExplainsWhy } from './lib/failure-presentation-oracle.mjs';

const healthy = assertEveryUnhealthyStateExplainsWhy({
  activityHistory: [{
    severity: 'error',
    phase: 'settled',
    logicalStage: 'utilityComposing',
    detail: { failure: {
      code: 'RECURSION_PROVIDER_TIMEOUT',
      stage: 'utility-composing',
      category: 'provider-timeout',
      message: 'The selected model connection did not respond before the time limit.',
      retryable: true,
      suggestedAction: 'Check the selected connection profile, then try again.'
    } }
  }],
  progressRun: { steps: [{
    id: 'composing-prompt-packet',
    label: 'Composing prompt packet',
    state: 'failed',
    reason: 'The selected model connection did not respond before the time limit.',
    suggestedAction: 'Check the selected connection profile, then try again.',
    failureCode: 'RECURSION_PROVIDER_TIMEOUT'
  }] },
  renderedRows: [{
    label: 'Composing prompt packet',
    state: 'failed',
    reason: 'The selected model connection did not respond before the time limit.',
    action: 'Try: Check the selected connection profile, then try again.',
    text: 'Composing prompt packet failed The selected model connection did not respond before the time limit. Try: Check the selected connection profile, then try again.'
  }]
});
assertEqual(healthy.ok, true, 'complete readable failure passes oracle');

for (const [name, patch, expected] of [
  ['missing descriptor', { activityHistory: [{ severity: 'error', phase: 'settled', detail: {} }] }, 'missing detail.failure'],
  ['generic reason', { progressRun: { steps: [{ id: 'x', label: 'X', state: 'failed', reason: 'Failed.' }] } }, 'generic reason'],
  ['prompt-ready failure', { progressRun: { steps: [{ id: 'recursion-prompt-ready', label: 'Recursion prompt ready', state: 'failed', reason: 'Connection timed out.' }] } }, 'prompt-ready'],
  ['code leak', { renderedRows: [{ label: 'X', state: 'failed', reason: 'Connection timed out.', action: '', text: 'RECURSION_PROVIDER_TIMEOUT' }] }, 'diagnostic code'],
  ['lost action', {
    progressRun: { steps: [{ id: 'x', label: 'X', state: 'failed', reason: 'Connection timed out.', suggestedAction: 'Try again.' }] },
    renderedRows: [{ label: 'X', state: 'failed', reason: 'Connection timed out.', action: '', text: 'Connection timed out.' }]
  }, 'suggested action']
]) {
  let error = null;
  try {
    assertEveryUnhealthyStateExplainsWhy({ activityHistory: [], progressRun: { steps: [] }, renderedRows: [], ...patch });
  } catch (caught) {
    error = caught;
  }
  assert(error, `${name} is rejected`);
  assert(String(error.message).toLowerCase().includes(expected), `${name} reports ${expected}`);
}

console.log('[pass] failure presentation oracle');
```

- [ ] **Step 2: Run the new test to verify the missing module**

```powershell
node tools/scripts/test-failure-presentation-oracle.mjs
```

Expected: FAIL with module-not-found for `failure-presentation-oracle.mjs`.

- [ ] **Step 3: Implement the oracle**

Create `tools/scripts/lib/failure-presentation-oracle.mjs`:

```js
const GENERIC_REASON = /^(failed|failure|warning|caution|needs attention|action failed|provider call failed)[.!]?$/i;
const FAILURE_CODE = /\bRECURSION_[A-Z0-9_]+\b/;

function unhealthy(value = {}) {
  return ['warning', 'error', 'failed'].includes(String(value.severity || value.state || '').toLowerCase())
    || ['warning', 'error'].includes(String(value.outcome || '').toLowerCase());
}

function fail(message) {
  throw new Error(`Readable failure oracle: ${message}`);
}

function flattenSteps(steps = []) {
  return (Array.isArray(steps) ? steps : []).flatMap((step) => [
    step,
    ...flattenSteps(step?.children)
  ]);
}

export function assertEveryUnhealthyStateExplainsWhy({
  activityHistory = [],
  progressRun = {},
  renderedRows = []
} = {}) {
  for (const event of Array.isArray(activityHistory) ? activityHistory : []) {
    if (!unhealthy(event)) continue;
    if (!event?.detail?.failure?.message) fail('unhealthy activity is missing detail.failure');
  }

  const steps = flattenSteps(progressRun?.steps);
  for (const step of steps) {
    if (!unhealthy(step)) continue;
    const reason = String(step.reason || '').trim();
    if (!reason || GENERIC_REASON.test(reason)) fail(`step ${step.id || step.label || 'unknown'} has a generic reason`);
    if (step.id === 'recursion-prompt-ready' && step.state === 'failed') fail('failed settlement mapped to prompt-ready');
  }

  for (const row of Array.isArray(renderedRows) ? renderedRows : []) {
    if (!unhealthy(row)) continue;
    if (FAILURE_CODE.test(String(row.text || ''))) fail('compact UI leaked a diagnostic code');
    const step = steps.find((candidate) => candidate.id === row.id || candidate.label === row.label);
    if (step?.suggestedAction && !String(row.action || '').includes(step.suggestedAction)) {
      fail(`step ${step.id || step.label || 'unknown'} lost its suggested action`);
    }
  }

  return { ok: true };
}
```

- [ ] **Step 4: Run the oracle and full script discovery**

```powershell
node tools/scripts/test-failure-presentation-oracle.mjs
npm.cmd test
```

Expected: PASS. `run-tests.mjs` discovers the new `test-*.mjs` automatically.

- [ ] **Step 5: Commit Task 6**

```powershell
git add tools/scripts/lib/failure-presentation-oracle.mjs tools/scripts/test-failure-presentation-oracle.mjs
git commit -m "test: enforce readable failure presentation"
```

---

### Task 7: Update the design and architecture contracts

**Files:**
- Modify: `DESIGN.md`
- Modify: `docs/design/UI_SPEC.md`
- Modify: `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`
- Modify: `docs/architecture/STORAGE_AND_DIAGNOSTICS.md`
- Modify: `docs/superpowers/specs/2026-07-17-recursion-layered-failure-recovery-design.md`

**Interfaces:**
- Consumes: implemented behavior from Tasks 1-6.
- Produces: one consistent public contract matching production behavior.

- [ ] **Step 1: Amend the Progress menu paragraph in `DESIGN.md`**

Replace its warning/failure explanation sentence with:

```markdown
Warning and failed rows include one compact explanation block: a wrapped,
sanitized reason in the matching amber or red state color, followed by an
optional subdued `Try:` line when the failure descriptor contains a meaningful
user action. Reason and action are visible without hover. Tooltips and
accessibility text repeat them but are supplementary. Stable internal failure
codes remain available in diagnostics and do not appear in ordinary progress
copy.
```

- [ ] **Step 2: Amend `docs/design/UI_SPEC.md`**

Add these fields to the documented `progressRun.steps[]` shape:

```js
suggestedAction: 'Check the selected connection profile, then try again.',
failureCode: 'RECURSION_PROVIDER_TIMEOUT'
```

Add the terminal routing rule:

```markdown
A successful generic `settled` event may complete `Recursion prompt ready`.
A warning or error generic settlement must instead update the step named by
its `logicalStage`; an unknown logical stage uses `Preparing Recursion
response`. A failed settlement must never render `Recursion prompt ready` as
failed.
```

Add the action presentation rule:

```markdown
When an unhealthy step has `suggestedAction`, render `Try: <action>` directly
below its reason in subdued helper text. Omit the element from layout when no
action exists. `failureCode` is diagnostic metadata and is never ordinary row
text.
```

- [ ] **Step 3: Amend provider and diagnostics architecture docs**

Add to `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`:

```markdown
Provider failures cross the runtime/activity boundary only as normalized
failure descriptors. Known errors use fixed, sanitized user copy; unknown
provider errors say that the selected model connection could not complete the
request. Timeout copy says `before the time limit` unless the classifier owns
the exact effective duration. Provider retry and routing policy is unchanged.
```

Add to `docs/architecture/STORAGE_AND_DIAGNOSTICS.md`:

```markdown
Compact warning/failure UI consumes `failure.message` and optional
`failure.suggestedAction`. Journals, the Full Viewer, and sanitized diagnostic
exports retain `failure.code`, `stage`, and `category`. Internal codes must not
be interpolated into ordinary progress reason/action text.
```

- [ ] **Step 4: Link the focused design from the layered recovery design**

Add under its progress/UI section:

```markdown
Readable terminal copy, logical-stage settlement routing, visible suggested
actions, and diagnostic-only failure codes are further specified in
`docs/superpowers/specs/2026-07-22-readable-failure-presentation-design.md`.
```

- [ ] **Step 5: Check documentation consistency**

```powershell
rg -n "Unexpected internal failure|RECURSION_ACTIVITY_REASON_MISSING|failed.*Recursion prompt ready|suggestedAction|failureCode" DESIGN.md docs src tools/scripts
```

Expected: production/tests/docs agree that compact fallback copy is readable,
failed settlements do not map to prompt-ready, and codes remain diagnostic.
Historical evidence fixtures may retain literal old screenshots or captured
output only when clearly labeled historical.

- [ ] **Step 6: Commit Task 7**

```powershell
git add DESIGN.md docs/design/UI_SPEC.md docs/architecture/PROVIDER_AND_GENERATION_SPEC.md docs/architecture/STORAGE_AND_DIAGNOSTICS.md docs/superpowers/specs/2026-07-17-recursion-layered-failure-recovery-design.md docs/superpowers/specs/2026-07-22-readable-failure-presentation-design.md docs/superpowers/plans/2026-07-22-readable-failure-presentation.md
git commit -m "docs: define readable failure presentation"
```

---

## Completion Audit

- [ ] `rg -n "detail:\s*\{\s*message" src` returns no unhealthy activity producer using the legacy shape.
- [ ] `rg -n "Unexpected internal failure \(RECURSION_" src tools/scripts` returns no current production expectation.
- [ ] Known provider errors have fixed readable messages and meaningful actions.
- [ ] Unknown internal errors retain codes in descriptors but use friendly compact copy.
- [ ] Failed generic settlements route through `logicalStage` or `recursion-runtime`.
- [ ] No failed step is labeled `Recursion prompt ready`.
- [ ] Warning/failed row reason and optional action are visible without hover.
- [ ] Ordinary progress row text contains no `RECURSION_*` code.
- [ ] Cancellation, supersession, skip, cached, clean success, and successful retry tests still pass.
- [ ] `npm.cmd test` passes.
