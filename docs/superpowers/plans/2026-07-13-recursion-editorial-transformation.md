# Recursion Editorial Transformation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` for each implementation task. Use `superpowers:subagent-driven-development` only when the work is explicitly delegated. This plan is intentionally sequential because its schema, runtime, UI, cache, and tests share one contract.

**Goal:** Replace the patch-only Enhancement contract with evidence-led
`Repair`, `Recompose`, and `Redirect` modes. Repair retains deterministic local
patching; Recompose and Redirect can write one complete validated candidate.

**Architecture:** Create `src/editorial-transform.mjs` as the single owner of
evidence reference construction, diagnosis/transform/verifier request building,
schema validation, and safe artifact application helpers. `src/runtime.mjs`
captures the immutable generation snapshot, first routes an independently
validated diagnosis, then routes one mode-specific transform request using that
diagnosis, optionally runs a High/Ultra binary verifier, and applies a
validated artifact as a swipe or permitted replacement. `src/providers.mjs`
owns the three role registrations, expected schemas, and the one shared
structured-output correction token. `src/generation-review.mjs` and old
prose/dialogue enhancement paths are removed in the same change; pre-alpha
Recursion does not retain a compatibility bridge.

**No tournament rule:** one invocation produces at most one editorial
candidate. Diagnosis writes no candidate; verification is binary accept/reject
and may not write, rank, or request another candidate.

## Contract summary

```ts
type EnhancementSettings = {
  mode: 'off' | 'repair' | 'recompose' | 'redirect';
  applyMode: 'as-swipe' | 'replace';
  contextMessages: number;
};

type ValidatedEditorialArtifact =
  | { kind: 'patches'; mode: 'repair'; patches: EditorialPatch[] }
  | { kind: 'candidate'; mode: 'recompose' | 'redirect'; text: string; candidate: EditorialCandidate };
```

`redirect` normalizes `applyMode` to `as-swipe`. No old `enhancements.target`,
`on`, `prose`, `dialogue`, `prose-dialogue`, or legacy schema is accepted.

## Phase 0: Define evidence authority, diagnosis, provider roles, and budgets

**Files:**

- Add: `src/editorial-transform.mjs`
- Add: `tools/scripts/test-editorial-transform.mjs`
- Modify: `src/providers.mjs`
- Modify: `tools/scripts/test-providers.mjs`
- Modify: `src/progress.mjs`
- Modify: `tools/scripts/test-progress.mjs`

### 0.1 Start with diagnosis and authority tests

The contract test must distinguish source-draft from continuity evidence and
prove that a draft-only citation cannot preserve an invented source fact. It
must also prove that a Repair diagnosis can recommend Recompose/Redirect
without calling the transformer.

```js
assertEqual(
  validateEditorialDiagnosis({
    ...repairEscalation,
    decision: 'requires-recompose',
    brief: { ...repairEscalation.brief, preserve: [{ claim: 'Invented source fact', evidenceRefs: ['source:0'] }] }
  }, fixture).ok,
  false,
  'source-draft evidence cannot establish a preservation claim'
);
assertEqual(
  validateEditorialDiagnosis(repairEscalation, fixture).decision,
  'requires-recompose',
  'Repair can expose a non-automatic escalation outcome'
);
```

### 0.2 Add distinct schemas and bounded validators

```js
export const EDITORIAL_DIAGNOSIS_SCHEMA = 'recursion.editorialDiagnosis.v1';
export const EDITORIAL_PASS_SCHEMA = 'recursion.editorialPass.v1';
export const EDITORIAL_VERIFICATION_SCHEMA = 'recursion.editorialVerification.v1';

const DIAGNOSIS_DECISIONS = new Map([
  ['repair', new Set(['proceed', 'no-change', 'requires-recompose', 'requires-redirect'])],
  ['recompose', new Set(['proceed', 'no-change', 'requires-redirect'])],
  ['redirect', new Set(['proceed', 'no-change'])]
]);

export function validateEditorialDiagnosis(result = {}, fixture = {}) {
  if (result.schema !== EDITORIAL_DIAGNOSIS_SCHEMA) return fail('RECURSION_EDITORIAL_DIAGNOSIS_SCHEMA_MISMATCH', 'Editorial diagnosis returned the wrong schema.');
  if (result.mode !== fixture.mode || result.sourceHash !== fixture.sourceHash || result.snapshotHash !== fixture.snapshotHash) {
    return fail('RECURSION_EDITORIAL_DIAGNOSIS_STALE', 'Editorial diagnosis does not match the frozen source.');
  }
  if (!DIAGNOSIS_DECISIONS.get(result.mode)?.has(result.decision)) {
    return fail('RECURSION_EDITORIAL_DIAGNOSIS_DECISION_INVALID', 'Editorial diagnosis returned an invalid decision for this mode.');
  }
  return validateEditorialBrief(result.brief, buildEditorialEvidence(fixture.reviewSnapshot, fixture.sourceText));
}
```

`buildEditorialEvidence` must emit an authority class for every item and clamp
the count/excerpt limits from the design spec. `validateEditorialBrief` and
`validateEditorialPass` must enforce ledger/reference/text limits before any
result reaches a marker or host adapter. After a diagnosis passes validation,
derive `diagnosisHash` from its canonical public form; never accept a
provider-supplied diagnosis hash as authoritative.

### 0.3 Register the exact provider roles and one correction token

Replace `generationReviewer` rather than adding aliases in the existing
`UTILITY_ROLE_IDS` and response-schema registry:

```js
export const UTILITY_ROLE_IDS = Object.freeze([
  'utilityArbiter',
  // existing roles...
  'editorialDiagnostician',
  'editorialTransformer',
  'editorialVerifier',
  'providerTest'
]);

const ROLE_RESPONSE_SCHEMAS = Object.freeze({
  // existing mappings...
  editorialDiagnostician: 'recursion.editorialDiagnosis.v1',
  editorialTransformer: 'recursion.editorialPass.v1',
  editorialVerifier: 'recursion.editorialVerification.v1'
});
```

Remove the `generationReviewer` special normalizer and its response schema
mapping in `src/providers.mjs`. Add an operation-scoped
`editorialRecoveryToken` passed from runtime: Diagnosis may spend it; Transform
may request structured recovery only when it remains unspent; Verifier always
uses `{ allowStructuredRecovery: false }`. Update progress role mapping for all
three roles and assert that the verifier cannot create a candidate row.

The runtime retains the existing Reasoner-to-Utility fallback shape for the
same role/request when Reasoner fails before the recovery token is spent. That
fallback does not mint a second correction token and does not change the
diagnosis hash or candidate identity.

Run:

```powershell
node tools\scripts\test-editorial-transform.mjs
node tools\scripts\test-providers.mjs
node tools\scripts\test-progress.mjs
```

## Phase 1: Define the V1 settings and visible vocabulary

**Files:**

- Modify: `src/settings.mjs`
- Modify: `src/ui.mjs`
- Modify: `src/ui/view-model.mjs`
- Modify: `styles/recursion.css`
- Modify: `tools/scripts/test-settings.mjs`
- Modify: `tools/scripts/test-ui.mjs`
- Modify: `DESIGN.md`
- Modify: `docs/design/UI_SPEC.md`

### 1.1 Write failing settings tests

Replace the Generation Review assertions with the V1 mode contract:

```js
assertDeepEqual(
  normalizeEnhancementsSettings({}),
  { mode: 'off', applyMode: 'as-swipe', contextMessages: 13 },
  'editorial enhancements default to Off and preserve the compact context limit'
);
assertDeepEqual(
  normalizeEnhancementsSettings({ mode: 'recompose', applyMode: 'replace', contextMessages: 21 }),
  { mode: 'recompose', applyMode: 'replace', contextMessages: 21 },
  'Recompose permits an explicit Replace preference'
);
assertDeepEqual(
  normalizeEnhancementsSettings({ mode: 'redirect', applyMode: 'replace', contextMessages: 13 }),
  { mode: 'redirect', applyMode: 'as-swipe', contextMessages: 13 },
  'Redirect is always applied as a swipe'
);
assertDeepEqual(
  normalizeEnhancementsSettings({ mode: 'prose-dialogue' }),
  { mode: 'off', applyMode: 'as-swipe', contextMessages: 13 },
  'pre-alpha V1 rejects obsolete enhancement targets'
);
```

Run:

```powershell
node tools\scripts\test-settings.mjs
```

Expected: fails until the setting shape changes.

### 1.2 Replace the normalizer

```js
const EDITORIAL_MODES = new Set(['off', 'repair', 'recompose', 'redirect']);

export function normalizeEnhancementsSettings(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const mode = enumValue(source.mode, EDITORIAL_MODES, DEFAULT_RECURSION_SETTINGS.enhancements.mode);
  const requestedApplyMode = enumValue(
    source.applyMode,
    ENHANCEMENT_APPLY_MODES,
    DEFAULT_RECURSION_SETTINGS.enhancements.applyMode
  );
  return {
    mode,
    applyMode: mode === 'redirect' ? 'as-swipe' : requestedApplyMode,
    contextMessages: Math.round(numberInRange(
      source.contextMessages,
      DEFAULT_RECURSION_SETTINGS.enhancements.contextMessages,
      ENHANCEMENT_CONTEXT_MIN,
      ENHANCEMENT_CONTEXT_MAX
    ))
  };
}
```

Change the default settings to:

```js
enhancements: {
  mode: 'off',
  applyMode: 'as-swipe',
  contextMessages: 13
}
```

### 1.3 Update the compact selector

Replace the current `Off`/`Enhancement` target options with four compact rows:

```js
const EDITORIAL_MODE_OPTIONS = Object.freeze([
  { value: 'off', label: 'Off', tip: 'Do not edit completed responses.' },
  { value: 'repair', label: 'Repair', tip: 'Correct local, evidence-backed defects.' },
  { value: 'recompose', label: 'Recompose', tip: 'Rewrite this response into a stronger supported draft.' },
  { value: 'redirect', label: 'Redirect', tip: 'Create the response this turn needed as a swipe.' }
]);

function effectiveEnhancementApplyMode(mode, applyMode) {
  return mode === 'redirect' ? 'as-swipe' : normalizeEnhancementApplyMode(applyMode);
}
```

Keep the existing compact graphite popover, placement, focus behavior, and
upgrade icon. Do not add a separate confirmation modal, giant comparison card,
or a persistent mode dashboard. Disable the Replace choice while Redirect is
selected and render its existing helper-text treatment with `Redirect always
creates a swipe.`

### 1.4 Verify

```powershell
node tools\scripts\test-settings.mjs
node tools\scripts\test-ui.mjs
```

Update `DESIGN.md` and `docs/design/UI_SPEC.md` with the exact labels, default
swipe behavior, disabled Redirect replace control, and status language. The UI
tests must assert the modes, labels, selected state, ARIA labels, disabled
control, and compact order in the bar.

## Phase 2: Implement the candidate-transform contract

**Files:**

- Remove: `src/generation-review.mjs`
- Remove: `src/dialogue-enhancement.mjs`
- Remove: `src/prose-enhancement.mjs`
- Remove: `tools/scripts/test-generation-review.mjs`
- Remove: `tools/scripts/test-dialogue-enhancement.mjs`
- Remove: `tools/scripts/test-prose-enhancement.mjs`

### 2.1 Add candidate contract tests

The new test script must cover all three artifact shapes, unknown evidence,
wrong source/snapshot, stale candidate, required-card coverage, forbidden
patches in full modes, full rewrite acceptance, and Redirect's source-negative
brief.

```js
const evidence = [
  { id: 'user:0', kind: 'user-turn', excerpt: 'She closes the door and asks who sent him.' },
  { id: 'packet:scene', kind: 'prompt-packet', excerpt: 'Keep the visitor unknown; do not resolve the threat.' },
  { id: 'card:relationship', kind: 'installed-card', excerpt: 'Their trust is strained, not broken.' }
];

const fullRecompose = {
  schema: EDITORIAL_PASS_SCHEMA,
  mode: 'recompose',
  sourceHash: 'source-a',
  snapshotHash: 'snapshot-a',
  diagnosisHash: 'diagnosis-a',
  cardOutcomes: [{ cardId: 'relationship', status: 'honored', evidenceRefs: ['card:relationship'] }],
  candidate: {
    text: 'The latch clicked behind her. “Who sent you?” she asked. He looked past her shoulder instead of answering.',
    preservationLedger: [{ claim: 'The sender remains unknown.', evidenceRefs: ['packet:scene'] }],
    changeLedger: [{ kind: 'rewrite', summary: 'Made the question the opening pressure.', evidenceRefs: ['user:0'] }],
    riskFlags: ['none']
  }
};

assertEqual(
  validateEditorialPass(fullRecompose, fixture).ok,
  true,
  'a materially different full Recompose can pass without a patch ratio limit'
);
assertEqual(
  validateEditorialPass({ ...fullRecompose, mode: 'repair' }, fixture).ok,
  false,
  'Repair cannot smuggle a full candidate through its patch contract'
);
```

### 2.2 Implement the transform validator

The module must have no host mutation and no provider invocation. It owns the
schema family, public snapshot conversion, authority-aware evidence index,
diagnosis/transform/verifier prompt construction, patch application, candidate
validation, and cache-key composition.

```js
export const EDITORIAL_PASS_SCHEMA = 'recursion.editorialPass.v1';
export const EDITORIAL_MODES = new Set(['repair', 'recompose', 'redirect']);
const FULL_CANDIDATE_MODES = new Set(['recompose', 'redirect']);

export function validateEditorialPass(result = {}, {
  mode = '', sourceText = '', sourceHash = '', snapshotHash = '', diagnosisHash = '', targets = {}, reviewSnapshot = {}
} = {}) {
  if (result?.schema !== EDITORIAL_PASS_SCHEMA) return fail('RECURSION_EDITORIAL_SCHEMA_MISMATCH', 'Editorial pass returned the wrong schema.');
  if (result.mode !== mode) return fail('RECURSION_EDITORIAL_MODE_MISMATCH', 'Editorial pass returned a different mode.');
  if (result.sourceHash !== sourceHash || result.snapshotHash !== snapshotHash) {
    return fail('RECURSION_EDITORIAL_STALE_SOURCE', 'Editorial pass was produced for a different frozen response.');
  }
  if (result.diagnosisHash !== diagnosisHash) return fail('RECURSION_EDITORIAL_DIAGNOSIS_STALE', 'Editorial pass used a different diagnosis.');
  const evidence = buildEditorialEvidence(reviewSnapshot, sourceText);
  const evidenceIds = new Set(evidence.map((item) => item.id));
  if (!validateEvidenceClosure(result, evidenceIds)) {
    return fail('RECURSION_EDITORIAL_EVIDENCE_INVALID', 'Editorial pass cited missing or invalid frozen evidence.');
  }
  const cardResult = validateCardOutcomes(result.cardOutcomes, reviewSnapshot.installedHand, evidenceIds);
  if (!cardResult.ok) return cardResult;
  if (mode === 'repair') return validateRepairArtifact(result, { targets, sourceText, evidenceIds, cardResult });
  return validateCandidateArtifact(result, { mode, sourceText, evidenceIds, cardResult });
}
```

`validateCandidateArtifact` must compare normalized source/candidate text only
to reject no-ops. It must not enforce an edit-distance cap. Its deterministic
constraint scan consumes explicitly tagged hard constraints from the frozen
Prompt Packet, story form, and installed-card manifest; untagged prose remains
the verifier/model's editorial domain.

### 2.3 Build the transform request from a validated diagnosis

```js
export function buildEditorialPassRequest(input = {}) {
  const mode = normalizeEditorialMode(input.mode);
  const snapshot = publicEditorialSnapshot(input.reviewSnapshot);
  const evidence = buildEditorialEvidence(snapshot, input.sourceText);
  const fullCandidate = FULL_CANDIDATE_MODES.has(mode);
  return {
    responseSchema: EDITORIAL_PASS_SCHEMA,
    machineJson: true,
    lane: input.lane,
    reasoningCategory: 'editorial-transform',
    reasoningIntent: input.reasoningIntent,
    prompt: [
      'Return only one valid Recursion Editorial Pass JSON object.',
      `Mode: ${mode}.`,
      fullCandidate
        ? 'Return exactly one complete candidate. You may replace every source sentence when the evidence-led brief supports it.'
        : 'Return only exact non-overlapping replacements for supplied targets.',
      mode === 'redirect'
        ? 'The source may be negative evidence. Preserve only facts supported by the frozen evidence.'
        : 'Preserve the supported turn state while improving execution.',
      'Cite only evidence IDs supplied below. Do not invent facts or resolve an open player choice.',
      `<source_hash>${input.sourceHash}</source_hash>`,
      `<snapshot_hash>${input.snapshotHash}</snapshot_hash>`,
      `<diagnosis>${JSON.stringify(input.diagnosis)}</diagnosis>`,
      `<evidence>${JSON.stringify(evidence)}</evidence>`,
      `<snapshot>${JSON.stringify(snapshot)}</snapshot>`,
      mode === 'repair' ? `<targets>${JSON.stringify(eligibleGenerationReviewTargets(input.targets))}</targets>` : '',
      `<source>${input.sourceText}</source>`
    ].filter(Boolean).join('\n')
  };
}
```

### 2.4 Verify

```powershell
node tools\scripts\test-editorial-transform.mjs
```

Expected: `[pass] editorial transform`.

## Phase 3: Replace runtime orchestration, marker, and cache identity

**Files:**

- Modify: `src/runtime.mjs`
- Modify: `src/enhancement-context.mjs`
- Modify: `src/enhancement-metrics.mjs`
- Modify: `src/progress.mjs`
- Modify: `src/runtime/diagnostics.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `tools/scripts/test-progress.mjs`
- Modify: `tools/scripts/test-extension-smoke.mjs`

### 3.1 Capture a frozen editorial snapshot

At the current `enhanceLatestAssistantMessageImpl` seam, derive `mode` from
settings, capture the source, and build one immutable public snapshot. Do not
build source targets for Recompose/Redirect. Then obtain and validate the
diagnosis before any transform call.

```js
const editorialMode = settings.enhancements?.mode || 'off';
if (editorialMode === 'off') return settleEnhancementSkipped({ runId, reason: 'editorial-off' });

const sourceText = latestAssistant.text;
const sourceHash = hashText(sourceText);
const reviewSnapshot = buildGenerationReviewSnapshot({
  latestAssistant,
  context: enhancementContext,
  promptPacket: currentPromptPacket,
  lastBrief: currentLastBrief,
  installedHand,
  storyForm,
  antiSlopProfileVersion: ANTI_SLOP_PROFILE_VERSION
});
const snapshotHash = editorialSnapshotHash(reviewSnapshot);
const targets = editorialMode === 'repair' ? buildEnhancementTargets(sourceText) : {};
const recoveryToken = { spent: false };
const diagnosisResponse = await generateEditorial('editorialDiagnostician', buildEditorialDiagnosisRequest({
  mode: editorialMode, sourceText, sourceHash, snapshotHash, reviewSnapshot
}), { recoveryToken });
const diagnosis = validateEditorialDiagnosis(diagnosisResponse.result.data, {
  mode: editorialMode, sourceText, sourceHash, snapshotHash, reviewSnapshot
});
if (!diagnosis.ok || diagnosis.decision !== 'proceed') {
  return settleEditorialDiagnosisOutcome({ runId, diagnosis, sourceText });
}
```

Rename snapshot helpers as part of the same refactor if they are editorial
rather than review-specific. There must be one source of truth for the
snapshot/public-snapshot/hash relationship.

Use one runtime wrapper for the three roles so recovery ownership is real rather
than prompt-only policy:

```js
async function generateEditorial(roleId, request, {
  recoveryToken,
  allowStructuredRecovery = true
} = {}) {
  const response = await generationRouter.generate(roleId, request, {
    runId,
    timeoutMs: EDITORIAL_TIMEOUT_MS,
    allowStructuredRecovery: allowStructuredRecovery && recoveryToken?.spent !== true
  });
  if (response?.recoverySpent === true && recoveryToken) recoveryToken.spent = true;
  return { result: response, lane: request.lane };
}
```

Wrap this helper with the current same-role Reasoner-to-Utility fallback before
returning. The fallback uses the same `recoveryToken` object and therefore
cannot reset the operation budget.

### 3.2 Use a mode-safe cache key

```js
const key = editorialPassKey({
  chatKey: identity.chatKey,
  messageId,
  swipeId: identity.swipeId ?? 0,
  sourceHash,
  snapshotHash,
  diagnosisHash: diagnosis.hash,
  editorialMode,
  applyMode: effectiveEnhancementApplyMode(editorialMode, settings.enhancements?.applyMode),
  verificationRequired: shouldVerifyEditorialCandidate({ editorialMode, reasoningLevel: settings.reasoningLevel })
});
```

Do not allow a cache hit from a different editorial mode, an unverified
candidate to satisfy a verification-required run, or a live deck/prompt change
to reuse a candidate from another frozen snapshot.

### 3.3 Produce exactly one candidate from the accepted diagnosis

```js
const response = await generateEditorial('editorialTransformer', buildEditorialPassRequest({
  mode: editorialMode,
  sourceText,
  sourceHash,
  snapshotHash,
  diagnosis: diagnosis.value,
  targets,
  reviewSnapshot,
  lane: editorialLaneForSettings(settings),
  reasoningIntent: editorialReasoningIntent(settings.reasoningLevel)
}), { recoveryToken });

const validation = response.result?.ok === true
  ? validateEditorialPass(response.result.data, { mode: editorialMode, sourceText, sourceHash, snapshotHash, diagnosisHash: diagnosis.hash, targets, reviewSnapshot })
  : response;
if (!validation.ok) return settleEnhancementFailure({ runId, validation });
```

Diagnosis and Transform share one router recovery token: a correction spent by
Diagnosis sets `recoveryToken.spent = true` and invokes Transform with
`allowStructuredRecovery: false`; otherwise Transform may spend it. Verification
always runs without structured recovery. The runtime does not add a semantic
rewrite retry. In particular, a rejected candidate is not an excuse to ask for
a smaller candidate, then a bigger one, or a second alternative.

### 3.4 Add binary High/Ultra verification

Only full-candidate modes at High/Ultra call the verifier. The verifier accepts
the candidate/snapshot/evidence and returns an immutable decision, not text.

```js
if (shouldVerifyEditorialCandidate({ editorialMode, reasoningLevel: settings.reasoningLevel })) {
  const verdict = await generateEditorial('editorialVerifier', buildEditorialVerificationRequest({
    mode: editorialMode,
    sourceHash,
    snapshotHash,
    diagnosisHash: diagnosis.hash,
    evidence: buildEditorialEvidence(reviewSnapshot, sourceText),
    candidate: validation.artifact.candidate
  }), { recoveryToken, allowStructuredRecovery: false });
  const verdictValidation = validateEditorialVerification(verdict?.result?.data, { sourceHash, snapshotHash });
  if (!verdictValidation.ok || verdictValidation.decision !== 'accept') {
    return settleEnhancementFailure({ runId, validation: verdictValidation, reason: 'editorial-verification-rejected' });
  }
}
```

`buildEditorialVerificationRequest` must state: *Do not rewrite, score,
compare, rank, or propose another candidate. Return only accept/reject with
known evidence IDs.* Its response schema is
`recursion.editorialVerification.v1`; it gets no correction retry.

### 3.5 Persist a bounded editorial marker and apply safely

Create only this compact marker shape; candidate/source text and raw provider
payloads must never be copied into it:

```js
const requestedApplyMode = settings.enhancements?.applyMode || 'as-swipe';
const applyMode = editorialMode === 'redirect' ? 'as-swipe' : requestedApplyMode;
const transformedText = validation.artifact.kind === 'patches'
  ? applyGenerationReviewPatches(sourceText, validation.artifact.patches)
  : validation.artifact.text;
const marker = {
  schema: 'recursion.editorialMarker.v1',
  chatKey: identity.chatKey,
  messageId,
  swipeId: identity.swipeId ?? 0,
  mode: editorialMode,
  applyMode,
  sourceHash,
  snapshotHash,
  diagnosisHash: diagnosis.hash,
  candidateHash: hashText(transformedText),
  key,
  outcome: 'applied',
  producerLane: response.lane,
  verification: verificationResult?.decision || 'not-required',
  cardOutcomes: compactCardOutcomes(validation.cardOutcomes),
  preservationLedger: compactEditorialLedger(validation.artifact.candidate?.preservationLedger),
  changeLedger: compactEditorialLedger(validation.artifact.candidate?.changeLedger),
  riskFlags: compactRiskFlags(validation.artifact.candidate?.riskFlags)
};
```

```js
if (applyMode === 'replace') {
  await messages.replaceAssistantMessage({ messageId, text: transformedText, marker });
} else {
  await messages.appendAssistantMessageSwipe({ messageId, text: transformedText, marker });
  await messages.selectAssistantMessageSwipe({ messageId, swipeId: 'latest' });
}
```

Keep the existing hold/reveal, cancellation, stale-run, cache marker, and host
message identity guards. A stale source or failed application must reveal the
original and never mutate a later swipe.

### 3.6 Runtime tests

Add tests for:

- Repair patch application and `requires-recompose` result without host write.
- A total Recompose applied as a swipe, preserving the original swipe.
- Explicit Recompose Replace.
- Redirect's forced swipe even when settings request Replace.
- source/snapshot/card/evidence mismatch leaving host messages unchanged.
- all modes exactly diagnosis plus producer; High/Ultra full modes add one
  binary verifier, never two candidates.
- verifier reject, parser failure, cancellation, stale run, cache hit, and
  changed snapshot behavior.
- diagnosis `no-change`, `requires-recompose`, and `requires-redirect` show
  their exact progress/marker/journal state and make no host mutation.

Run:

```powershell
node tools\scripts\test-runtime.mjs
node tools\scripts\test-progress.mjs
node tools\scripts\test-extension-smoke.mjs
```

## Phase 4: Progress, inspection, and diagnostics

**Files:**

- Modify: `src/ui/view-model.mjs`
- Modify: `src/ui.mjs`
- Modify: `styles/recursion.css`
- Modify: `src/runtime/diagnostics.mjs`
- Modify: `tools/scripts/test-ui.mjs`
- Modify: `tools/scripts/test-diagnostics.mjs`

Use stable pre-created progress rows. The mode determines only labels/details;
it must not reconstruct the menu on every heartbeat.

```js
const editorialRows = [
  { id: 'capture-editorial-evidence', label: 'Captured frozen evidence' },
  { id: 'editorial-brief', label: 'Editorial brief' },
  { id: 'editorial-candidate', label: mode === 'redirect' ? 'Redirect candidate' : mode === 'recompose' ? 'Recompose candidate' : 'Repair patches' },
  { id: 'editorial-validation', label: 'Evidence and constraint validation' },
  ...(verificationRequired ? [{ id: 'editorial-verification', label: 'Editorial verification' }] : []),
  { id: 'enhanced-swipe', label: applyMode === 'replace' ? 'Enhanced response' : 'Enhanced swipe' }
];
```

The result inspector shows source/result, mode, application result, short
change ledger, preservation ledger, card outcomes, risk flags, lane, and
verification decision. It excludes raw prompts, provider text, and hidden
reasoning from marker/diagnostic persistence.

## Phase 5: Add quality evaluation before documentation closeout

**Files:**

- Add: `tests/evaluation/scenarios/editorial/repair.json`
- Add: `tests/evaluation/scenarios/editorial/recompose.json`
- Add: `tests/evaluation/scenarios/editorial/redirect.json`
- Modify: `tools/scripts/eval-recursion-models.mjs`
- Modify: `tools/scripts/test-model-eval-harness.mjs`
- Modify: `tools/scripts/lib/model-eval-harness.mjs`

The editorial contract tests prove validity; this fixed replay corpus proves
that valid output is editorially useful. Each fixture contains a frozen public
snapshot, source response, expected authority facts, prohibited resolutions,
and an adjudication rubric. It contains no private prompt/provider payloads.

```js
const EDITORIAL_RUBRIC = Object.freeze([
  'answers the immediate user turn before optional atmosphere',
  'preserves every declared hard constraint and continuity fact',
  'does not resolve a declared open question or invent a consequential fact',
  'makes a concrete scene, voice, pacing, or dialogue improvement',
  'uses the selected mode correctly; Redirect treats flawed source prose as removable'
]);
```

Gate a release candidate on the recorded corpus: all deterministic validation
checks pass; no evaluated candidate has an unsupported continuity error; at
least 80% of Recompose cases are judged materially stronger than their source;
and at least 90% of Redirect cases directly engage the user turn without
resolving a declared open state. The evaluator judges only the one produced
candidate; it never supplies or selects alternatives.

Extend the existing pack parser rather than inventing a parallel evaluator:

```js
const PACKS = new Set(['smoke', 'core', 'stress', 'editorial']);
const JUDGE_TASKS = Object.freeze(['cards', 'packet', 'output', 'editorial']);
```

The `editorial` judge receives the frozen public snapshot, source text, one
validated candidate, selected mode, and rubric only. It must return structured
per-criterion pass/fail evidence; it must not emit replacement text.

Run:

```powershell
node tools\scripts\test-model-eval-harness.mjs
node tools\scripts\eval-recursion-models.mjs --pack editorial
```

## Phase 6: Update schemas, docs, and examples in place

**Files:**

- Add: `schemas/editorial-diagnosis.v1.json`
- Add: `schemas/editorial-pass.v1.json`
- Add: `schemas/editorial-verification.v1.json`
- Modify: `docs/architecture/ENHANCEMENT_REVIEW_AND_PATCH_CONTRACT.md`
- Modify: `docs/technical/RUNTIME_TURN_SEQUENCE.md`
- Modify: `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md`
- Modify: `docs/architecture/CACHE_USE_AND_REUSE_SPEC.md`
- Modify: `docs/testing/TESTING_STRATEGY.md`
- Modify: `docs/user/RECURSION_OPERATOR_MANUAL.md`
- Modify: `docs/DOCUMENTATION_INDEX.md`

The architectural contract must replace all claims that full rewrites are
impossible or material defects require host regeneration. It must document the
new evidence-authority floor, diagnosis/candidate schemas, mode/application
restrictions, no tournament rule, shared correction budget, and High/Ultra
binary verification. Remove obsolete
Generation Review schemas/examples instead of leaving two authoritative
contracts.

Schema excerpt:

```json
{
  "$id": "recursion.editorialPass.v1",
  "type": "object",
  "required": ["schema", "mode", "sourceHash", "snapshotHash", "diagnosisHash", "cardOutcomes"],
  "properties": {
    "schema": { "const": "recursion.editorialPass.v1" },
    "mode": { "enum": ["repair", "recompose", "redirect"] },
    "diagnosisHash": { "type": "string", "minLength": 1, "maxLength": 180 },
    "patches": { "type": "array" },
    "candidate": {
      "type": "object",
      "required": ["text", "preservationLedger", "changeLedger", "riskFlags"]
    }
  },
  "allOf": [
    { "if": { "properties": { "mode": { "const": "repair" } } }, "then": { "required": ["patches"], "not": { "required": ["candidate"] } } },
    { "if": { "properties": { "mode": { "enum": ["recompose", "redirect"] } } }, "then": { "required": ["candidate"], "not": { "required": ["patches"] } } }
  ]
}
```

## Phase 7: Full verification and removal audit

Run the focused suite, then the project gates defined by `package.json`:

```powershell
node tools\scripts\test-settings.mjs
node tools\scripts\test-editorial-transform.mjs
node tools\scripts\test-runtime.mjs
node tools\scripts\test-progress.mjs
node tools\scripts\test-ui.mjs
node tools\scripts\test-diagnostics.mjs
node tools\scripts\test-model-eval-harness.mjs
node tools\scripts\test-extension-smoke.mjs
npm.cmd test
```

Before declaring the feature complete, search for stale contract vocabulary:

```powershell
rg -n "generationReview|generation-review|generationReviewer|prose-dialogue|dialogueEnhancer|proseEnhancer|Never return a full rewritten message" src schemas docs tests tools
```

Every remaining occurrence must either be intentionally generic historical
documentation or be removed/renamed. Then validate a live host sequence for
each mode:

1. Repair makes a bounded correction and leaves the original available.
2. Recompose produces a visibly substantial, evidence-backed swipe and its
   inspector ledger matches frozen card/prompt evidence.
3. Redirect never replaces in place, even after the user chose Replace before
   selecting it.
4. High/Ultra verification accepts or rejects the one candidate without a
   second candidate call.
5. Repair escalation is an explicit no-write result, not an automatic mode
   change or host regeneration.
6. cancellation, malformed output, stale source, and verifier rejection leave
   the original assistant message visible and intact.

## Delivery criteria

- One coherent V1 contract exists across code, schemas, tests, user docs, and
  technical documentation.
- There is no hidden full rewrite under Repair and no patch constraint under
  Recompose/Redirect.
- Every accepted full candidate is source/snapshot/diagnosis-bound and
  authority-aware evidence-closed.
- Diagnosis and Transform share one structured-output correction token; a
  verifier can neither correct output nor create a candidate.
- The fixed editorial corpus meets its continuity, Recompose-strength, and
  Redirect-engagement gates before release.
- The user sees the actual editorial mode, result, and verification state.
- No tournament code, ranking prompt, candidate array, or automatic selection
  path exists.
