# Recursion Structured Output Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover more useful provider output without weakening Recursion’s V1 machine-output contracts.

**Architecture:** `src/providers.mjs` remains the single owner of retries, provider calls, raw-text lifetime, and sanitized recovery metadata. The structured parser reports deterministic eligibility facts; `src/cards.mjs` validates Fused fragments through the ordinary card contract; Standard pipeline/UI code consumes only compact result metadata.

**Scope addition:** This plan also implements `generationReviewer` semantic recovery. The router owns the one external correction budget, while `src/generation-review.mjs` decides whether a structurally valid review result is safe, normalizable, repairable, partial, or hard-failed.

**Tech Stack:** JavaScript ES modules, existing provider router and SillyTavern adapter, deterministic Node test scripts, markdown contracts.

## Global Constraints

- Recursion is pre-alpha; update code, docs, schemas, tests, and examples in place to the best current contract.
- One initial call plus at most one structured or semantic recovery request per failed slot/result. Valid siblings never retry.
- Parser/schema recovery and Generation Review semantic recovery share that one external correction budget; neither may add a second provider call after the other spends it.
- Transport retry and structured-output recovery are separate policies.
- No raw-text reformat after token-limit, empty-content, reasoning-only, timeout, abort, stale-run, or transport failure.
- Raw text and raw repair prompts stay in memory, capped at 12,000 visible characters, and never appear in diagnostics or persisted state.
- Fused is the only generic partial-response recovery surface until another schema has independently valid members.
- Recovered output still passes the same schema, role, family, snapshot, evidence, and prompt-safety validation as an initial response.

---

## File Structure

Generation Review adds these implementation surfaces to the parser/card work below:

- `src/generation-review.mjs`: normalize only documented outcome aliases; classify safe patches, repairable outcome-ledger defects, and hard failures; build a frozen semantic-correction request.
- `src/runtime.mjs`: send `generationReviewer` the generation-time pipeline mode, installed-hand manifest, source-card lineage, and cache provenance; preserve `partial-failed` rather than falsely calling a partial result successful.
- `tools/scripts/test-generation-review.mjs`: prove the one-budget rule, semantic normalization, missing-card coverage, safe partial results, and hard patch rejection.

- `src/providers/structured-output-parser.mjs` — deterministic candidate extraction and complete-object eligibility.
- `src/providers.mjs` — batch-slot recovery, raw-text reformat request building, retry budget, and compact diagnostics.
- `src/cards.mjs` — strict Fused fragment snapshot and item validation.
- `src/runtime/pipelines/standard.mjs` — one compact card-level recovery reason; no raw response handling.
- `tools/scripts/test-provider-response-parser.mjs` — complete-versus-truncated parser behavior.
- `tools/scripts/test-providers.mjs` — recovery routing, one-attempt budget, lane/source locality, and redaction.
- `tools/scripts/test-runtime.mjs` — valid sibling retention and recovered Fused-item authority.
- `tools/scripts/test-progress.mjs`, `tools/scripts/test-ui.mjs` — compact amber recovery presentation.
- Provider/testing/operator documentation listed in Task 5.

---

### Task 1: Expose complete-object eligibility from the parser

**Files:**

- Modify: `src/providers/structured-output-parser.mjs`
- Modify: `tools/scripts/test-provider-response-parser.mjs`

**Interfaces:**

- Produces: `hasBalancedJsonObject(text) -> boolean`
- Produces: `extractJsonStringProperty(text, propertyName) -> string`
- Consumed by: `src/providers.mjs`

- [ ] **Step 1: Write the failing parser assertions**

```js
import {
  extractJsonStringProperty,
  hasBalancedJsonObject,
  parseStructuredJsonText
} from '../../src/providers/structured-output-parser.mjs';

assertEqual(
  hasBalancedJsonObject('Before {"schema":"recursion.utilityArbiter.v1","ok":true} after'),
  true,
  'complete object may be considered for bounded raw reformat'
);
assertEqual(
  hasBalancedJsonObject('{"schema":"recursion.utilityArbiter.v1","ok":'),
  false,
  'truncated object cannot be reformatted'
);
assertEqual(
  extractJsonStringProperty('{"snapshotHash":"fused-current","items":[{"promptText":"partial"}', 'snapshotHash'),
  'fused-current',
  'complete leading snapshot string is extracted without accepting the broken envelope'
);
```

- [ ] **Step 2: Run the focused test and confirm red**

Run:

```powershell
node tools\scripts\test-provider-response-parser.mjs
```

Expected: failure because `hasBalancedJsonObject` is not exported.

- [ ] **Step 3: Add the minimal parser helper**

Add immediately after `extractBalancedJsonObject(...)`:

```js
export function hasBalancedJsonObject(text = '') {
  const candidate = extractBalancedJsonObject(text);
  return Boolean(candidate) && candidate.endsWith('}');
}

export function extractJsonStringProperty(text = '', propertyName = '') {
  const escaped = String(propertyName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`"${escaped}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`).exec(String(text || ''));
  if (!match) return '';
  try {
    const value = JSON.parse(match[1]);
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}
```

This is intentionally not a semantic validity check. It prevents the raw-text path from receiving an obvious incomplete tail; normal parsing and validation remain authoritative.

- [ ] **Step 4: Verify green**

Run:

```powershell
node tools\scripts\test-provider-response-parser.mjs
```

Expected: `[pass] provider response parser`.

- [ ] **Step 5: Commit**

```powershell
git add src/providers/structured-output-parser.mjs tools/scripts/test-provider-response-parser.mjs
git commit -m "test: define structured output recovery eligibility"
```

---

### Task 2: Give only invalid batch slots one correction attempt

**Files:**

- Modify: `src/providers.mjs`
- Modify: `tools/scripts/test-providers.mjs`

**Interfaces:**

- Produces: `diagnostics.retryCount: 1` for a recovered slot only.
- Produces: `diagnostics.structuredOutputRecovery: 'slot_correction_retry'`.
- Preserves: valid initial sibling results and existing batch transport retry behavior.

- [ ] **Step 1: Write the failing two-slot integration test**

```js
const batchCalls = [];
const slotRetryRouter = createGenerationRouter({
  client: {
    async batch(requests) {
      batchCalls.push(requests);
      if (batchCalls.length === 1) {
        return [
          { text: responseTextForRole('sceneFrameCard') },
          { text: '{"schema":"wrong.schema","items":[]}' }
        ];
      }
      return [{ text: responseTextForRole('sceneConstraintsCard') }];
    }
  }
});

const results = await slotRetryRouter.batch([
  { roleId: 'sceneFrameCard', prompt: 'Frame', snapshotHash: 'batch-retry-snapshot' },
  { roleId: 'sceneConstraintsCard', prompt: 'Constraints', snapshotHash: 'batch-retry-snapshot' }
]);

assertEqual(batchCalls.length, 2, 'invalid structured slot receives one follow-up request');
assertEqual(batchCalls[1].length, 1, 'follow-up includes only invalid slot');
assertEqual(batchCalls[1][0].roleId, 'sceneConstraintsCard', 'failed role is preserved');
assert(batchCalls[1][0].prompt.includes('Previous response was rejected'), 'follow-up is a correction request');
assertEqual(results[0].ok, true, 'initial valid sibling survives');
assertEqual(results[0].diagnostics.retryCount, 0, 'valid sibling is not retried');
assertEqual(results[1].ok, true, 'corrected sibling succeeds');
assertEqual(results[1].diagnostics.retryCount, 1, 'corrected sibling has one retry');
assertEqual(results[1].diagnostics.structuredOutputRecovery, 'slot_correction_retry', 'recovery is classified');
```

- [ ] **Step 2: Run and confirm red**

Run:

```powershell
node tools\scripts\test-providers.mjs
```

Expected: the assertion for a second one-slot batch request fails.

- [ ] **Step 3: Separate parsing from result settlement**

In `src/providers.mjs`, add this helper directly before `successResult(...)`:

```js
function parseBatchSlotAttempt(entry, raw) {
  throwSlotFailure(raw);
  const parsed = parseProviderStructuredOutput(raw?.text);
  const data = parsed.data;
  validateRoleResponseSchema(entry.roleId, data);
  return { data, parsed };
}

function structuredSlotRetryEligible(error) {
  return structuredOutputRetryableError(error);
}
```

Change `successResult(...)` to call `parseBatchSlotAttempt(entry, raw)`. Add a final `extraDiagnostics = {}` parameter and spread it into the sanitized diagnostics object:

```js
async function successResult(entry, raw, retryCount = 0, extraDiagnostics = {}) {
  const { data, parsed } = parseBatchSlotAttempt(entry, raw);
  const diagnostics = sanitize({
    ...entry.diagnostics,
    ...parsed.diagnostics,
    ...extraDiagnostics,
    // retain the current provider, response-hash, batch, retry, and latency fields
  }, 300);
  // retain the existing success journal append and returned result shape
}
```

Do not append a failed journal entry or settle the activity row before recovery eligibility has been decided.

- [ ] **Step 4: Add the slot-only retry pass**

Replace the terminal raw-response settlement loop with a first pass that accepts valid slots and queues invalid structured slots:

```js
const retryCandidates = [];
for (let batchIndex = 0; batchIndex < rawResponses.length; batchIndex += 1) {
  const entry = pendingEntries[batchIndex];
  const raw = rawResponses[batchIndex];
  try {
    results[entry.index] = await successResult(entry, raw, batchRetryCount);
    emitSlotSettledActivity(entry, raw, batchRetryCount);
  } catch (error) {
    if (structuredSlotRetryEligible(error) && entry.request.signal?.aborted !== true) {
      retryCandidates.push({ entry, error });
      continue;
    }
    results[entry.index] = await failureResult(entry, error, batchRetryCount, batchDiagnosticsFromResponse(raw));
    emitSlotFailureActivity(entry, error, raw, batchRetryCount, { force: true });
  }
}
```

After the loop, use `checkRetryFreshness(...)` with only `retryCandidates`. When fresh, make one `withBatchTimeout(...)` call with only their correction requests:

```js
const retriedRawResponses = await withBatchTimeout(
  (requestsWithSignals) => client.batch(requestsWithSignals),
  retryCandidates.map(({ entry, error }) => ({
    roleId: entry.roleId,
    ...requestWithStructuredRetryPrompt(entry.request, { roleId: entry.roleId, error })
  })),
  effectiveTimeoutMs,
  options.signal || null
);
```

Map each retry response back to its original `entry.index`. Call `successResult(entry, retriedRaw, 1, { structuredOutputRecovery: 'slot_correction_retry' })`; if it fails, settle it with `failureResult(...)`. If freshness fails or the follow-up batch throws, settle every queued candidate with its original sanitized error and a compact `retrySkippedReason`. Never leave an element of `results` undefined.

- [ ] **Step 5: Verify green**

Run:

```powershell
node tools\scripts\test-providers.mjs
```

Expected: `[pass] providers`, including exactly two batch calls and a one-item follow-up.

- [ ] **Step 6: Commit**

```powershell
git add src/providers.mjs tools/scripts/test-providers.mjs
git commit -m "fix: retry invalid structured batch slots once"
```

---

### Task 3: Choose one bounded recovery request and keep raw text private

**Files:**

- Modify: `src/providers.mjs`
- Modify: `tools/scripts/test-providers.mjs`

**Interfaces:**

- Produces: `structuredOutputRecovery: 'raw_reformat_retry'` only after a successful same-lane raw reformat.
- Preserves: no more than one recovery request after the initial call.

- [ ] **Step 1: Write the raw-reformat, truncation, and redaction tests**

```js
const marker = 'RAW_STRUCTURED_REPAIR_MARKER';
const prompts = [];
const rawRepairRouter = createGenerationRouter({
  client: {
    async generate(roleId, request) {
      prompts.push(request.prompt);
      if (prompts.length === 1) return { text: `{ schema: 'recursion.utilityArbiter.v1', note: '${marker}' }` };
      return { text: responseTextForRole(roleId) };
    }
  }
});

const repaired = await rawRepairRouter.generate('utilityArbiter', {
  prompt: 'Return Arbiter JSON.',
  snapshotHash: 'raw-repair-snapshot'
});

assertEqual(repaired.ok, true, 'complete damaged object can be reformatted');
assertEqual(prompts.length, 2, 'reformat uses one follow-up request');
assert(prompts[1].includes(marker), 'repair request receives the bounded visible source');
assertEqual(repaired.diagnostics.structuredOutputRecovery, 'raw_reformat_retry', 'reformat outcome is explicit');
assertNoProviderMarker(repaired, marker, 'raw source does not leave the router result');
```

Add a separate token-limit fixture. It must return `RECURSION_PROVIDER_TOKEN_LIMIT` after one request, never a second raw-repair request.

- [ ] **Step 2: Run and confirm red**

Run:

```powershell
node tools\scripts\test-providers.mjs
```

Expected: the raw-reformat recovery code does not exist.

- [ ] **Step 3: Add shared recovery request selection**

Import `hasBalancedJsonObject` and add these helpers beside `requestWithStructuredRetryPrompt(...)`:

```js
const RAW_STRUCTURED_REPAIR_MAX_CHARS = 12000;

function rawStructuredRepairEligible(error, rawText) {
  const text = String(rawText || '');
  return error?.code === 'RECURSION_JSON_PARSE_FAILED'
    && text.length > 0
    && text.length <= RAW_STRUCTURED_REPAIR_MAX_CHARS
    && hasBalancedJsonObject(text);
}

function requestWithRawStructuredRepairPrompt(request = {}, { roleId = '', rawText = '' } = {}) {
  const expected = expectedResponseSchema(roleId);
  const snapshotHash = String(request.snapshotHash || '').trim();
  return {
    ...request,
    prompt: [
      String(request.prompt || ''),
      '',
      'Reformat the following complete malformed visible response into exactly one valid JSON object.',
      `Use schema "${expected}".`,
      snapshotHash ? `Use snapshotHash "${snapshotHash}".` : '',
      'Preserve only supported information present in the malformed response. Do not invent facts, evidence, or card text.',
      'Return JSON only, with no reasoning, markdown, or commentary.',
      'Malformed visible response:',
      String(rawText).slice(0, RAW_STRUCTURED_REPAIR_MAX_CHARS)
    ].filter(Boolean).join('\n')
  };
}
```

For each initial parse failure, select either raw reformat or schema correction, never both:

```js
const rawText = String(raw?.text || '');
const recovery = rawStructuredRepairEligible(error, rawText)
  ? 'raw_reformat_retry'
  : 'slot_correction_retry';

const retryRequest = recovery === 'raw_reformat_retry'
  ? requestWithRawStructuredRepairPrompt(request, { roleId, rawText })
  : requestWithStructuredRetryPrompt(request, { roleId, error });
```

Use the same selection in the batch retry candidate record. The raw text stays only on the candidate object until the retry settles, then is discarded. Add `structuredOutputRecovery: recovery` only to a successful retry’s sanitized diagnostics.

- [ ] **Step 4: Verify green**

Run:

```powershell
node tools\scripts\test-providers.mjs
```

Expected: `[pass] providers`; complete malformed input gets one reformat request, truncated input gets none, and the marker is absent from returned and persisted diagnostic surfaces.

- [ ] **Step 5: Commit**

```powershell
git add src/providers.mjs tools/scripts/test-providers.mjs
git commit -m "feat: add bounded raw structured-output reformat"
```

---

### Task 4: Make Fused recovery strictly data-backed and surface compact caution

**Files:**

- Modify: `src/cards.mjs`
- Modify: `src/runtime/pipelines/standard.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `tools/scripts/test-progress.mjs`
- Modify: `tools/scripts/test-ui.mjs`

**Interfaces:**

- Produces: valid Fused fragments only when the fragment carries a verified current snapshot association.
- Produces: amber card reason for `slot_correction_retry` or `raw_reformat_retry`.

- [ ] **Step 1: Write the Fused stale-fragment regression**

Construct a malformed Fused `items` response containing a complete current `Scene Frame` and a complete stale `Scene Constraints` item. Assert that the first card is accepted, the stale item is rejected, and the missing family is regenerated rather than accepted under a runtime-authored snapshot.

- [ ] **Step 2: Run and confirm red**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: failure until the recovery path refuses a fragment without an explicit matching snapshot.

- [ ] **Step 3: Guard the recovered snapshot before transient envelope creation**

In `cardsFromFusedProviderResult(...)`, obtain the recovery-envelope snapshot from the failed raw response before constructing the transient bundle. It must not use the runtime's expected snapshot as a substitute:

```js
const expectedSnapshotHash = String(context.expectedSnapshotHash || context.snapshotHash || '').trim();
const recoveredSnapshot = extractJsonStringProperty(result.recoverableText || result.text || '', 'snapshotHash');
if (!expectedSnapshotHash || recoveredSnapshot !== expectedSnapshotHash) {
  output.diagnostics.push('fused-bundle-recovered-snapshot-mismatch');
  return finalize();
}
result = {
  ...result,
  ok: true,
  data: {
    schema: CARD_BUNDLE_RESPONSE_SCHEMA,
    snapshotHash: recoveredSnapshot,
    items: recoveredItems
  }
};
```

Immediately before passing each recovered item to `cardsFromProviderResult(...)`, reject a fragment with an explicit stale item hash:

```js
const itemSnapshot = String(item.snapshotHash || recoveredSnapshot).trim();
if (itemSnapshot !== expectedSnapshotHash) {
  output.invalidFamilies.push(catalog.family);
  output.diagnostics.push(`fused-item-snapshot-mismatch:${catalog.family}`);
  continue;
}
```

Pass `snapshotHash: itemSnapshot` into the transient `recursion.card.v1` envelope. Do not substitute `expectedSnapshotHash` when provider data omitted it.

In `src/runtime/pipelines/standard.mjs`, replace the retry-reason helper with:

```js
function providerCardRetryReason(retryCount, batched = false, recovery = '') {
  const count = progressRetryCount(retryCount);
  if (!count) return '';
  const prefix = batched ? 'Provider card batch' : 'Provider card call';
  if (recovery === 'raw_reformat_retry') return `${prefix} reformatted damaged JSON once before this card completed.`;
  if (recovery === 'slot_correction_retry') return `${prefix} retried once after structured-output validation.`;
  return `${prefix} retried ${count === 1 ? 'once' : `${count} times`} before this card completed.`;
}
```

Pass `result?.diagnostics?.structuredOutputRecovery` at its existing call site. Keep the result amber through the existing nonzero retry count; add no raw text and no new per-card progress row.

- [ ] **Step 4: Verify green**

Run:

```powershell
node tools\scripts\test-runtime.mjs
node tools\scripts\test-progress.mjs
node tools\scripts\test-ui.mjs
```

Expected: all three report `[pass]`; current Fused fragments survive, stale/missing-snapshot fragments do not, and UI copy remains compact.

- [ ] **Step 5: Commit**

```powershell
git add src/cards.mjs src/runtime/pipelines/standard.mjs tools/scripts/test-runtime.mjs tools/scripts/test-progress.mjs tools/scripts/test-ui.mjs
git commit -m "fix: validate recovered fragments and show retry caution"
```

---

### Task 5: Add Generation Review semantic recovery under the shared budget

**Files:**

- Modify: `src/generation-review.mjs`
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-generation-review.mjs`
- Modify: `tools/scripts/test-providers.mjs`
- Modify: `tools/scripts/test-progress.mjs`
- Modify: `tools/scripts/test-ui.mjs`

**Interfaces:**

- Consumes: `generationRouter.generate('generationReviewer', request)` result with `recoverySpent`, `structuredOutputRecovery`, and sanitized diagnostics.
- Produces: `normalizeCardOutcomeStatus(value) -> string`, `classifyGenerationReviewFailure(validation)`, and `buildGenerationReviewCorrectionRequest(snapshot, failure)`.
- Preserves: one external correction request total for a review result, regardless of whether the initial defect was parser/schema or semantic.

- [ ] **Step 1: Write the semantic-boundary regressions**

```js
const snapshot = reviewSnapshotWithInstalledCards(['location', 'direction']);
const validPatch = patchFor('dialogue:1', '"No."', '"No. Not yet."');

assertEqual(
  normalizeCardOutcomeStatus('not_applicable'),
  'not-applicable',
  'documented provider alias normalizes deterministically'
);

const missingCoverage = validateGenerationReviewResult({
  ...validReviewResult({ patches: [validPatch] }),
  cardOutcomes: [{ cardId: 'location', status: 'honored', evidenceTargetIds: ['dialogue:1'] }]
}, reviewValidationInput(snapshot));
assertEqual(missingCoverage.ok, false, 'missing installed outcome does not become success');
assertEqual(missingCoverage.code, 'RECURSION_GENERATION_REVIEW_CARD_OUTCOME_MISSING');
assertEqual(missingCoverage.retryable, true, 'missing coverage is one semantic correction candidate');
assertEqual(missingCoverage.safePatches.length, 1, 'safe bounded patch remains eligible for partial result');

const unsafePatch = validateGenerationReviewResult({
  ...validReviewResult({ patches: [{ ...validPatch, before: 'different source' }] }),
  cardOutcomes: completeOutcomes(snapshot)
}, reviewValidationInput(snapshot));
assertEqual(unsafePatch.ok, false, 'source-mismatched patch fails');
assertEqual(unsafePatch.safePatches.length, 0, 'unsafe patch can never apply partially');
```

- [ ] **Step 2: Run and confirm red**

Run:

```powershell
node tools\scripts\test-generation-review.mjs
```

Expected: FAIL because aliases, missing coverage, and safe partial classification are not yet represented by the validator.

- [ ] **Step 3: Implement deterministic semantic classification**

In `src/generation-review.mjs`, add the only permitted outcome aliases and retain explicit installed-card coverage:

```js
const CARD_OUTCOME_ALIASES = new Map([
  ['not_applicable', 'not-applicable'],
  ['partially_reflected', 'partially-reflected'],
  ['requires_regeneration', 'requires-regeneration'],
  ['partially reflected', 'partially-reflected']
]);

export function normalizeCardOutcomeStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  return CARD_OUTCOME_ALIASES.get(raw) || raw;
}

function semanticFailure(code, details = {}) {
  return { ok: false, code, retryable: true, ...details };
}
```

Normalize only the outgoing card outcome status before validating it. Return `semanticFailure('RECURSION_GENERATION_REVIEW_CARD_OUTCOME_MISSING', { missingCardIds, safePatches: patches })` only after every patch has passed source, target, non-empty, and overlap validation. Keep unknown card IDs, source mismatch, overlapping targets, stale source hash, and invalid patch text as non-retryable hard failures with no `safePatches`.

- [ ] **Step 4: Spend one shared correction budget**

In `src/runtime.mjs`, send the semantic correction only when the router did not already consume recovery:

```js
const initial = await generationRouter.generate('generationReviewer', reviewRequest);
let validation = validateGenerationReviewResult(initial.data, reviewValidationInput(snapshot));

if (!validation.ok && validation.retryable === true && initial.recoverySpent !== true) {
  const correction = buildGenerationReviewCorrectionRequest({
    request: reviewRequest,
    sourceHash: snapshot.source.hash,
    pipeline: snapshot.pipeline,
    invalidTargetIds: validation.invalidTargetIds || [],
    invalidCardIds: validation.invalidCardIds || validation.missingCardIds || []
  });
  const corrected = await generationRouter.generate('generationReviewer', {
    ...correction,
    structuredRecovery: { kind: 'semantic_correction_retry' }
  });
  validation = validateGenerationReviewResult(corrected.data, reviewValidationInput(snapshot));
}

if (!validation.ok && !validation.safePatches?.length) {
  return settleEnhancementFailure({ runId, validation });
}
return applyValidatedReview({
  patches: validation.safePatches || validation.patches,
  outcome: validation.ok ? 'applied' : 'partial-failed',
  unresolvedCardIds: validation.ok ? [] : validation.missingCardIds || validation.invalidCardIds || []
});
```

The correction prompt must request only the invalid card-outcome entries or the invalid patch target IDs. It must include the frozen source hash, pipeline mode (`standard`, `rapid`, or `fused`), installed-hand manifest, card source lineage, and the same review snapshot. It must not send provider raw output, hidden reasoning, or a mutable current deck.

- [ ] **Step 5: Render partial truth without false colors**

Keep the fixed `Generation review` parent row amber/red according to its existing partial-failure mapping. Safe applied patches and individually verified card outcomes remain green; unresolved outcome children are red and use gray text with `failed` at right. A parser/schema recovery is amber only when it produces a valid final review. Do not add blue or an `unverified` state.

```js
setProgressStep({ id: `generation-review-card:${cardId}`, state: 'failed', detail: 'outcome coverage missing' });
setProgressStep({ id: 'generation-review', state: 'failed', detail: 'partial result applied' });
```

- [ ] **Step 6: Verify green**

Run:

```powershell
node tools\scripts\test-generation-review.mjs
node tools\scripts\test-providers.mjs
node tools\scripts\test-progress.mjs
node tools\scripts\test-ui.mjs
```

Expected: all commands report `[pass]`; a parser retry followed by semantic failure performs no second correction, semantic correction happens once only, valid aliases normalize, and the UI does not represent unresolved coverage as success or caution.

- [ ] **Step 7: Commit**

```powershell
git add src\generation-review.mjs src\runtime.mjs tools\scripts\test-generation-review.mjs tools\scripts\test-providers.mjs tools\scripts\test-progress.mjs tools\scripts\test-ui.mjs
git commit -m "fix: unify generation review recovery"
```

---

### Task 6: Document and verify the final contract

**Files:**

- Modify: `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`
- Modify: `docs/architecture/ENHANCEMENT_REVIEW_AND_PATCH_CONTRACT.md`
- Modify: `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md`
- Modify: `docs/testing/TESTING_STRATEGY.md`
- Modify: `docs/user/RECURSION_OPERATOR_MANUAL.md`
- Modify: `docs/user/PROVIDER_SETUP.md`
- Modify: `docs/DOCUMENTATION_INDEX.md`

- [ ] **Step 1: Update contract language**

Add these final operator truths after implementation is proven:

```markdown
- Recursion repairs common JSON syntax damage before validation and retries one failed structured card slot with the exact required schema and snapshot hash.
- A repaired response is accepted only after ordinary schema, role, family, snapshot, and evidence validation.
- A failed Fused bundle may retain complete validated requested siblings; missing siblings regenerate independently.
- Parser/schema recovery and Generation Review semantic recovery share one provider correction budget. A structurally recovered result still receives semantic validation, but never another provider correction.
- A documented card-outcome alias may normalize locally. Missing/invalid installed-card coverage can receive the one semantic correction; unresolved coverage is `partial-failed`, never success.
- Diagnostics report compact recovery metadata only. They do not retain raw provider output or repair prompts.
```

Distinguish `RECURSION_JSON_PARSE_FAILED` (possibly syntactically damaged visible output) from `RECURSION_PROVIDER_SCHEMA_MISMATCH` (parseable output that fails the required role contract).

- [ ] **Step 2: Run focused verification**

```powershell
node tools\scripts\test-provider-response-parser.mjs
node tools\scripts\test-providers.mjs
node tools\scripts\test-runtime.mjs
node tools\scripts\test-generation-review.mjs
node tools\scripts\test-progress.mjs
node tools\scripts\test-ui.mjs
```

Expected: every command exits `0` and prints its `[pass]` line.

- [ ] **Step 3: Run repository gates**

```powershell
npm.cmd test
node tools\scripts\run-alpha-gate.mjs
```

Expected: exit `0`. Do not claim live-host proof from these deterministic tests.

- [ ] **Step 4: Commit**

```powershell
git add docs/architecture/PROVIDER_AND_GENERATION_SPEC.md docs/architecture/ENHANCEMENT_REVIEW_AND_PATCH_CONTRACT.md docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md docs/testing/TESTING_STRATEGY.md docs/user/RECURSION_OPERATOR_MANUAL.md docs/user/PROVIDER_SETUP.md docs/DOCUMENTATION_INDEX.md
git commit -m "docs: describe structured-output recovery"
```

## Self-review

- Task 2 targets the observed batch asymmetry first.
- Task 3 keeps the recovery budget to one follow-up and excludes truncated/token-limited output.
- Task 4 turns the existing Fused raw-fragment path into a stricter semantic-boundary check rather than a permissive fallback.
- Task 5 unifies Generation Review semantic validation with parser/schema recovery under one correction budget.
- Task 6 requires focused provider/runtime/privacy proof before repository gates and documents only the final implementation contract.
