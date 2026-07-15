# Recursion Redirect Improvement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended after the current overlapping worktree changes are reconciled) or `superpowers:executing-plans` to implement this plan task-by-task. Every production change follows `superpowers:test-driven-development`; each new regression must be observed failing for the intended reason before implementation.

**Goal:** Make Redirect produce and verify a materially different, evidence-backed turn trajectory, with private character-pressure guidance, verified cache identity, and tests that reject Recompose-style condensation as Redirect success.

**Architecture:** Extend the existing Editorial diagnosis -> transform -> verify pipeline instead of adding a second post-processing subsystem. `src/editorial-transform.mjs` remains the semantic contract owner; `src/providers.mjs` emits exact machine schemas; `src/runtime.mjs` owns orchestration, cache identity, private marker persistence, and terminal status; the SillyTavern host returns persisted markers during swipe reuse. The existing model-evaluation harness gains a loaded core-pack Redirect corpus and an independent output judge reached through a narrow internal runtime method and dedicated-user Playwright runner.

**Tech Stack:** JavaScript ES modules, JSON Schema structured provider calls, Node test scripts, SillyTavern host adapter, Playwright, PowerShell/npm.cmd.

## Global Constraints

- Recursion is pre-alpha. Update the V1 schema, code, tests, docs, and examples in place; add no compatibility shim.
- Preserve the original assistant response. Redirect always appends/selects one swipe and never uses Replace.
- Produce one diagnosis, one candidate with the existing single semantic correction allowance, and one accept/reject verifier. The verifier never writes or requests another candidate.
- Character pressure is advisory. It never requires increased pressure, speech, action, or one beat per character.
- Character-pressure data is private Recursion metadata. It must not enter visible UI, final prose, Last Brief, the next host prompt, or journal details.
- Every Redirect is verified at `low`, `medium`, `high`, and `ultra`; Recompose remains High/Ultra-only.
- Bind verification to mode, source hash, snapshot hash, diagnosis hash, and candidate hash.
- Do not treat edit distance, slop reduction, green progress, or self-reported card outcomes as Redirect semantic proof.
- Every live proof uses a dedicated `recursion-soak-*` user and real configured model calls. Never mutate `default-user` automatically.
- Preserve all pre-existing working-tree changes. Inspect and reconcile the current diff before editing or staging each task; never revert user-owned work.
- Stage only task-owned changes. If an overlapping file still contains unrelated modifications, defer that task's commit rather than staging unrelated work.

## File Structure

### Production contract

- Modify `src/editorial-transform.mjs`: Redirect constants, diagnosis validation, transformer rules, candidate validation, verifier identity/check validation, verification policy, effectiveness-judge request/validation.
- Modify `src/providers.mjs`: Redirect diagnosis/verifier schemas and internal `editorialEffectivenessJudge` role/schema.
- Verify or modify `src/providers/provider-response-normalizer.mjs`: preserve nested structured Redirect results.
- Modify `src/runtime.mjs`: shared verification policy, exact candidate verification, private marker persistence/reuse, settlement, narrow effectiveness-judge method.
- Modify `src/hosts/sillytavern/host.mjs`: return persisted marker from cached swipe lookup.

### Deterministic tests

- Modify `tools/scripts/test-providers.mjs`.
- Modify `tools/scripts/test-provider-response-parser.mjs`.
- Modify `tools/scripts/test-editorial-transform.mjs`.
- Modify `tools/scripts/test-editorial-runtime.mjs`.
- Modify `tools/scripts/test-host.mjs`.
- Modify `tools/scripts/test-runtime.mjs`.
- Modify `tools/scripts/test-ui.mjs`.
- Modify `tools/scripts/test-model-eval-harness.mjs`.

### Evaluation and live proof

- Modify `tools/scripts/lib/model-eval-harness.mjs`.
- Create `tools/scripts/lib/live-editorial-effectiveness.mjs`.
- Modify `tools/scripts/prove-live-enhancements.mjs`.
- Create six `tests/evaluation/scenarios/core/redirect-*.json` fixtures.

### Documentation

- Modify `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`.
- Modify `docs/testing/TESTING_STRATEGY.md`.
- Modify `docs/superpowers/specs/2026-07-13-recursion-editorial-transformation-design.md`.
- Keep `docs/superpowers/specs/2026-07-15-recursion-redirect-improvement-design.md` synchronized with implementation discoveries.

---

### Task 1: Add Shared Redirect Constants and the Diagnosis Machine Schema

**Files:**
- Modify: `src/editorial-transform.mjs`
- Modify: `src/providers.mjs`
- Modify: `tools/scripts/test-providers.mjs`
- Modify: `tools/scripts/test-provider-response-parser.mjs`

**Interfaces:**
- Produces: `REDIRECT_FAILURE_CATEGORIES`, `REDIRECT_PRESSURE_EFFECTS`, `REDIRECT_VERIFICATION_CHECKS`, `REDIRECT_ERROR_CODES` exports.
- Produces: Redirect-only fields in `editorialBriefSchema(mode, validEvidenceIds, validPreservationEvidenceIds)`.
- Preserves: existing Recompose diagnosis schema without Redirect-only fields.

- [ ] **Step 1: Write failing provider-schema tests**

Add a Redirect request next to the existing Recompose schema assertions:

```js
const redirectDiagnosisMachineSchema = machineJsonSchemaForRequest({
  responseSchema: 'recursion.editorialDiagnosis.v1',
  machineJson: true,
  mode: 'redirect',
  sourceHash: 'redirect-source-hash',
  snapshotHash: 'redirect-snapshot-hash',
  validEvidenceIds: ['user:0', 'card:active-cast', 'source:0'],
  validPreservationEvidenceIds: ['user:0', 'card:active-cast']
});

assertDeepEqual(
  redirectDiagnosisMachineSchema.schema.properties.brief.required,
  [
    'mode', 'diagnosis', 'preserve', 'discard', 'allowedChanges', 'forbiddenChanges',
    'sourceFailure', 'replacementObjective', 'requiredBeats', 'forbiddenSourceBeats',
    'sceneCharacters', 'characterPressure'
  ],
  'Redirect machine schema requires its turn-level contract'
);
assert(
  !editorialDiagnosisMachineSchema.schema.properties.brief.required.includes('characterPressure'),
  'Recompose machine schema remains free of Redirect-only fields'
);
assertDeepEqual(
  redirectDiagnosisMachineSchema.schema.properties.brief.properties.characterPressure.items.properties.wantEvidenceRefs.items.enum,
  ['user:0', 'card:active-cast'],
  'Redirect wants cannot cite source-draft evidence'
);
```

- [ ] **Step 2: Run the provider test and verify RED**

Run:

```powershell
npm.cmd run test:providers
```

Expected: FAIL because `brief.required` lacks `sourceFailure`/`characterPressure`, and Redirect nested schemas do not exist.

- [ ] **Step 3: Add shared constants and Redirect schema builders**

Add to `src/editorial-transform.mjs`:

```js
export const REDIRECT_FAILURE_CATEGORIES = Object.freeze([
  'turn-fulfillment',
  'core-direction',
  'hard-constraint',
  'unsupported-outcome',
  'temporal-causal',
  'character-epistemic'
]);

export const REDIRECT_PRESSURE_EFFECTS = Object.freeze([
  'increasing',
  'decreasing',
  'unchanged',
  'unclear'
]);

export const REDIRECT_VERIFICATION_CHECKS = Object.freeze([
  'source-failure-removed',
  'replacement-objective-fulfilled',
  'required-beats-satisfied',
  'forbidden-source-beats-excluded',
  'character-pressure-coherent',
  'hard-constraints-preserved',
  'user-turn-answered',
  'unsupported-facts-absent'
]);

export const REDIRECT_ERROR_CODES = Object.freeze({
  BRIEF_INVALID: 'RECURSION_EDITORIAL_REDIRECT_BRIEF_INVALID',
  EVIDENCE_INVALID: 'RECURSION_EDITORIAL_REDIRECT_EVIDENCE_INVALID',
  CHARACTER_COVERAGE_INVALID: 'RECURSION_EDITORIAL_REDIRECT_CHARACTER_COVERAGE_INVALID',
  PRESSURE_INVALID: 'RECURSION_EDITORIAL_REDIRECT_PRESSURE_INVALID',
  CHANGE_MISSING: 'RECURSION_EDITORIAL_REDIRECT_MISSING',
  VERIFICATION_CHECKS_INVALID: 'RECURSION_EDITORIAL_REDIRECT_VERIFICATION_CHECKS_INVALID',
  VERIFICATION_ACCEPT_INVALID: 'RECURSION_EDITORIAL_REDIRECT_VERIFICATION_ACCEPT_INVALID',
  VERIFICATION_REJECTED: 'RECURSION_EDITORIAL_VERIFICATION_REJECTED'
});
```

Import the arrays into `src/providers.mjs`. Extend `editorialBriefSchema()` with the exact `sourceFailure`, `replacementObjective`, `requiredBeats`, `forbiddenSourceBeats`, `sceneCharacters`, and `characterPressure` properties from the approved spec. Append those six names to `required` only when `mode === 'redirect'`.

- [ ] **Step 4: Add a provider-normalizer characterization test**

Add to `test-provider-response-parser.mjs`:

```js
const nestedRedirect = {
  schema: 'recursion.editorialDiagnosis.v1',
  mode: 'redirect',
  brief: {
    characterPressure: [{
      character: 'Carter',
      immediateWant: 'Test the transport method.',
      wantEvidenceRefs: ['user:0'],
      sourcePressureEffect: 'increasing',
      sourceEvidenceRefs: ['source:0'],
      pressureReason: 'The source postpones the test.'
    }]
  }
};
assertDeepEqual(
  JSON.parse(extractProviderResponseText(nestedRedirect)),
  nestedRedirect,
  'provider response normalization preserves nested Redirect fields'
);
```

Expected: PASS without production normalizer changes. If it fails, change only structured-object serialization; do not add Redirect-specific parsing.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
npm.cmd run test:providers
node tools/scripts/test-provider-response-parser.mjs
```

Expected: both PASS with no warning/error output.

- [ ] **Step 6: Commit the contract slice**

```powershell
git add src/editorial-transform.mjs src/providers.mjs tools/scripts/test-providers.mjs tools/scripts/test-provider-response-parser.mjs
git commit -m "feat: define redirect diagnosis contract"
```

---

### Task 2: Validate the Redirect Diagnosis and Build Its Pressure-Aware Prompt

**Files:**
- Modify: `src/editorial-transform.mjs`
- Modify: `tools/scripts/test-editorial-transform.mjs`

**Interfaces:**
- Consumes: Task 1 constants and existing `buildEditorialEvidence()` authority labels.
- Produces: `validateRedirectBrief(brief, evidence, decision)` used only by `validateEditorialDiagnosis()` when `mode === 'redirect'`.
- Produces: Redirect diagnosis prompt requiring evidence pairs, replacement trajectory, complete character coverage, and advisory pressure analysis.

- [ ] **Step 1: Add failing diagnosis fixtures**

Build one valid Redirect fixture and derive negative controls from it:

```js
const validRedirectBrief = {
  ...diagnosis.brief,
  mode: 'redirect',
  sourceFailure: {
    category: 'turn-fulfillment',
    problem: 'The source postpones the requested test.',
    establishedEvidenceRefs: ['user:0', 'card:relationship'],
    conflictingSourceRefs: ['source:0']
  },
  replacementObjective: {
    summary: 'Begin the supported test beat in this response.',
    evidenceRefs: ['user:0']
  },
  requiredBeats: [{ summary: 'Visibly engage the proposed test.', evidenceRefs: ['user:0'] }],
  forbiddenSourceBeats: [{ summary: 'Do not postpone the test.', sourceRefs: ['source:0'] }],
  sceneCharacters: [{ character: 'Carter', evidenceRefs: ['card:relationship'] }],
  characterPressure: [{
    character: 'Carter',
    immediateWant: 'Test the method directly.',
    wantEvidenceRefs: ['user:0'],
    sourcePressureEffect: 'increasing',
    sourceEvidenceRefs: ['source:0'],
    pressureReason: 'The source acknowledges and blocks the test.'
  }]
};

assertEqual(validateEditorialDiagnosis(redirectDiagnosis(validRedirectBrief), redirectFixture).ok, true, 'complete Redirect diagnosis passes');
assertEqual(validateEditorialDiagnosis(redirectDiagnosis({ ...validRedirectBrief, replacementObjective: null }), redirectFixture).ok, false, 'Redirect proceed requires replacement objective');
assertEqual(validateEditorialDiagnosis(redirectDiagnosis({
  ...validRedirectBrief,
  characterPressure: [{ ...validRedirectBrief.characterPressure[0], wantEvidenceRefs: ['source:0'] }]
}), redirectFixture).ok, false, 'source draft cannot establish a character want');
assertEqual(validateEditorialDiagnosis(redirectDiagnosis({
  ...validRedirectBrief,
  characterPressure: [{
    character: 'Carter',
    immediateWant: null,
    wantEvidenceRefs: [],
    sourcePressureEffect: 'unclear',
    sourceEvidenceRefs: [],
    pressureReason: 'Frozen evidence does not establish an immediate want.'
  }]
}), redirectFixture).ok, true, 'unclear want remains valid without invention');
```

Also add negatives for empty required/forbidden beats, source/non-source authority inversion, duplicate characters, mismatched character sets, empty names, concrete want without evidence, and unclear want with a concrete pressure effect.

- [ ] **Step 2: Run the transform test and verify RED**

```powershell
node tools/scripts/test-editorial-transform.mjs
```

Expected: FAIL because Redirect-only semantic validation is absent.

- [ ] **Step 3: Implement Redirect semantic validation**

Add authority helpers using the existing evidence map:

```js
function validateRedirectBrief(brief, evidence, decision) {
  const known = evidenceMap(evidence);
  const isSource = (id) => ['source-draft', 'source-negative'].includes(known.get(id)?.authority);
  const authoritative = (ids) => ids.length > 0 && ids.every((id) => known.has(id) && !isSource(id));
  const sourceOnly = (ids) => ids.length > 0 && ids.every((id) => known.has(id) && isSource(id));

  if (decision === 'no-change') {
    if (brief.sourceFailure !== null || brief.replacementObjective !== null) return fail(REDIRECT_ERROR_CODES.BRIEF_INVALID, 'Redirect no-change cannot carry a replacement.');
    if (brief.requiredBeats.length || brief.forbiddenSourceBeats.length) return fail(REDIRECT_ERROR_CODES.BRIEF_INVALID, 'Redirect no-change cannot carry replacement beats.');
  } else {
    if (!brief.sourceFailure || !brief.replacementObjective || !brief.requiredBeats.length || !brief.forbiddenSourceBeats.length) {
      return fail(REDIRECT_ERROR_CODES.BRIEF_INVALID, 'Redirect proceed requires a complete turn-level correction.');
    }
    if (!authoritative(brief.sourceFailure.establishedEvidenceRefs)
      || !sourceOnly(brief.sourceFailure.conflictingSourceRefs)
      || !authoritative(brief.replacementObjective.evidenceRefs)
      || brief.requiredBeats.some((beat) => !authoritative(beat.evidenceRefs))
      || brief.forbiddenSourceBeats.some((beat) => !sourceOnly(beat.sourceRefs))) {
      return fail(REDIRECT_ERROR_CODES.EVIDENCE_INVALID, 'Redirect evidence authority is invalid.');
    }
  }

  const characters = brief.sceneCharacters.map((entry) => String(entry.character || '').trim());
  const pressureCharacters = brief.characterPressure.map((entry) => String(entry.character || '').trim());
  if (characters.some((name) => !name)
    || new Set(characters).size !== characters.length
    || hashJson([...characters].sort()) !== hashJson([...pressureCharacters].sort())
    || brief.sceneCharacters.some((entry) => !authoritative(entry.evidenceRefs))) {
    return fail(REDIRECT_ERROR_CODES.CHARACTER_COVERAGE_INVALID, 'Redirect character coverage is invalid.');
  }

  for (const row of brief.characterPressure) {
    if (row.immediateWant === null) {
      if (row.wantEvidenceRefs.length || row.sourceEvidenceRefs.length || row.sourcePressureEffect !== 'unclear') {
        return fail(REDIRECT_ERROR_CODES.PRESSURE_INVALID, 'Unclear character pressure cannot claim concrete evidence or effect.');
      }
    } else if (!authoritative(row.wantEvidenceRefs) || !sourceOnly(row.sourceEvidenceRefs)) {
      return fail(REDIRECT_ERROR_CODES.EVIDENCE_INVALID, 'Redirect character pressure cited invalid evidence.');
    }
  }
  return { ok: true, value: brief };
}
```

Call it from `validateEditorialDiagnosis()` after general brief validation and before computing the diagnosis hash.

- [ ] **Step 4: Strengthen the diagnosis prompt**

For Redirect only, add instructions that require `sourceFailure`, `replacementObjective`, required/forbidden beats, all present characters, evidence-backed wants, and pressure effects. Include:

```js
'Redirect is a turn-level correction, not a more aggressive Recompose.',
'Pair established non-source evidence with the conflicting source passages.',
'List every character established as present by frozen evidence. Use null and unclear when an immediate want cannot be supported.',
'Character pressure is advisory evidence; do not require every character to speak or act.'
```

- [ ] **Step 5: Run focused tests and verify GREEN**

```powershell
node tools/scripts/test-editorial-transform.mjs
npm.cmd run test:providers
```

Expected: PASS.

- [ ] **Step 6: Commit the diagnosis slice**

```powershell
git add src/editorial-transform.mjs tools/scripts/test-editorial-transform.mjs
git commit -m "feat: validate redirect diagnosis"
```

---

### Task 3: Enforce a Directional Redirect Candidate

**Files:**
- Modify: `src/editorial-transform.mjs`
- Modify: `tools/scripts/test-editorial-transform.mjs`

**Interfaces:**
- Consumes: validated Redirect diagnosis from Task 2.
- Produces: Redirect transformer rules and mode-specific candidate validation.
- Preserves: generic Recompose full-candidate behavior.

- [ ] **Step 1: Add the OV-1 failing regression**

```js
const ov1MinorRewrite = editorialPass({
  mode: 'redirect',
  candidate: {
    text: 'Do it, but not yet. Not here. We will use the parking lot.',
    preservationLedger: redirectDiagnosis.brief.preserve,
    changeLedger: [{
      kind: 'reorder',
      summary: 'Condensed the directive.',
      evidenceRefs: ['source:0']
    }],
    riskFlags: []
  }
});
assertEqual(
  validateEditorialPass(ov1MinorRewrite, redirectPassFixture).ok,
  false,
  'Redirect rejects a Recompose-style condensation with no directional ledger'
);
```

Add a positive candidate whose `redirect` ledger cites `replacementObjective.evidenceRefs`, plus a negative whose `redirect` entry cites only source evidence.

- [ ] **Step 2: Run and verify RED**

```powershell
node tools/scripts/test-editorial-transform.mjs
```

Expected: FAIL because all full modes currently accept any known change kind.

- [ ] **Step 3: Add Redirect transformer rules**

Append only for `mode === 'redirect'`:

```js
const redirectRules = [
  'Rebuild the response around diagnosis.brief.replacementObjective.',
  'Include the supported substance of every required beat.',
  'Do not preserve any forbidden source beat, even with different wording.',
  'Use characterPressure as advisory evidence. Rising pressure makes a stronger response more likely but never mandatory.',
  'Silence, restraint, refusal, and delayed action remain valid when supported.',
  'A lexical rewrite that preserves the source objective or beat plan is not a Redirect.'
];
```

- [ ] **Step 4: Add mode-specific candidate validation**

Inside the full-candidate branch after general ledger validation:

```js
if (mode === 'redirect') {
  const redirects = data.candidate.changeLedger.filter((entry) => entry.kind === 'redirect');
  if (!redirects.length) {
    return fail(REDIRECT_ERROR_CODES.CHANGE_MISSING, 'Redirect candidate did not report a turn-level directional change.');
  }
  const objectiveRefs = new Set([
    ...diagnosis.brief.replacementObjective.evidenceRefs,
    ...diagnosis.brief.requiredBeats.flatMap((beat) => beat.evidenceRefs)
  ]);
  if (redirects.some((entry) => !entry.evidenceRefs.some((id) => objectiveRefs.has(id)))) {
    return fail(REDIRECT_ERROR_CODES.EVIDENCE_INVALID, 'Redirect ledger did not cite its replacement objective.');
  }
}
```

Do not add a minimum edit ratio. A lying `redirect` ledger may pass deterministic structure and is intentionally rejected by Task 4's verifier.

- [ ] **Step 5: Run and verify GREEN**

```powershell
node tools/scripts/test-editorial-transform.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit the candidate slice**

```powershell
git add src/editorial-transform.mjs tools/scripts/test-editorial-transform.mjs
git commit -m "feat: enforce redirect trajectory"
```

---

### Task 4: Bind and Validate Mandatory Redirect Verification

**Files:**
- Modify: `src/editorial-transform.mjs`
- Modify: `src/providers.mjs`
- Modify: `tools/scripts/test-editorial-transform.mjs`
- Modify: `tools/scripts/test-providers.mjs`

**Interfaces:**
- Produces: `editorialVerificationRequired(mode, reasoningLevel)`.
- Changes: `buildEditorialVerificationRequest()` and `validateEditorialVerification()` include `mode` and `candidateHash`.
- Produces: exact eight-check Redirect verification schema and validation.

- [ ] **Step 1: Add failing policy and verifier tests**

```js
for (const level of ['low', 'medium', 'high', 'ultra']) {
  assertEqual(editorialVerificationRequired('redirect', level), true, `Redirect verifies at ${level}`);
}
assertEqual(editorialVerificationRequired('recompose', 'medium'), false, 'Medium Recompose remains direct');
assertEqual(editorialVerificationRequired('recompose', 'high'), true, 'High Recompose verifies');

const redirectVerification = verificationResult({
  mode: 'redirect',
  candidateHash,
  decision: 'accept',
  checks: REDIRECT_VERIFICATION_CHECKS.map((check) => ({ check, status: 'pass', evidenceRefs: ['user:0'], note: 'Supported.' }))
});
assertEqual(validateEditorialVerification(redirectVerification, verificationFixture).ok, true, 'complete Redirect verification passes');
assertEqual(validateEditorialVerification({ ...redirectVerification, candidateHash: 'stale' }, verificationFixture).ok, false, 'verification binds exact candidate');
assertEqual(validateEditorialVerification({
  ...redirectVerification,
  checks: redirectVerification.checks.map((entry, index) => index ? entry : { ...entry, status: 'unclear' })
}, verificationFixture).ok, false, 'accept cannot contain unclear checks');
```

Add unknown, duplicate, missing, failed, and bad-evidence check cases.

- [ ] **Step 2: Add failing provider-schema tests**

Assert Redirect verifier schema requires `mode`, `candidateHash`, and exactly eight checks; Recompose requires identity but not `checks`.

- [ ] **Step 3: Run and verify RED**

```powershell
node tools/scripts/test-editorial-transform.mjs
npm.cmd run test:providers
```

Expected: FAIL on missing helper, candidate identity, and check schema.

- [ ] **Step 4: Implement shared policy and candidate-bound requests**

```js
export function editorialVerificationRequired(mode = '', reasoningLevel = '') {
  if (mode === 'redirect') return true;
  return mode === 'recompose' && ['high', 'ultra'].includes(reasoningLevel);
}

export function buildEditorialVerificationRequest({
  mode = '', sourceHash = '', snapshotHash = '', diagnosisHash = '', evidence = [], candidate = {}, lane = ''
} = {}) {
  const candidateHash = hashJson(String(candidate?.text || ''));
  return {
    ...requestBase(EDITORIAL_VERIFICATION_SCHEMA, prompt, lane),
    mode,
    sourceHash,
    snapshotHash,
    diagnosisHash,
    candidateHash,
    candidate,
    validEvidenceIds: evidence.map((entry) => String(entry.id || '')).filter(Boolean)
  };
}
```

Include all five identity values in the prompt and structured request.

- [ ] **Step 5: Implement verifier machine schema and semantic validation**

Use `REDIRECT_VERIFICATION_CHECKS` for `minItems`, `maxItems`, enum values, and exact required fields. Set `additionalProperties: false`. In semantic validation:

```js
if (data.schema !== EDITORIAL_VERIFICATION_SCHEMA
  || data.mode !== mode
  || data.sourceHash !== sourceHash
  || data.snapshotHash !== snapshotHash
  || data.diagnosisHash !== diagnosisHash
  || data.candidateHash !== candidateHash) {
  return fail('RECURSION_EDITORIAL_VERIFICATION_STALE', 'Editorial verification does not match the candidate.');
}
```

Validate exact check coverage. `decision: 'accept'` is invalid unless all eight statuses are `pass`. A structurally valid `reject` remains `{ok: true, decision: 'reject'}` so runtime can record verifier rejection accurately.

- [ ] **Step 6: Run and verify GREEN**

```powershell
node tools/scripts/test-editorial-transform.mjs
npm.cmd run test:providers
```

Expected: PASS.

- [ ] **Step 7: Commit the verification contract**

```powershell
git add src/editorial-transform.mjs src/providers.mjs tools/scripts/test-editorial-transform.mjs tools/scripts/test-providers.mjs
git commit -m "feat: verify every redirect candidate"
```

---

### Task 5: Integrate Verification, Cache Identity, Marker Reuse, and Settlement

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `src/hosts/sillytavern/host.mjs`
- Modify: `tools/scripts/test-editorial-runtime.mjs`
- Modify: `tools/scripts/test-host.mjs`

**Interfaces:**
- Consumes: `editorialVerificationRequired()` and candidate-bound verifier from Task 4.
- Changes: `messages.findEnhancedSwipe()` returns `{index, text, marker}`.
- Produces: persisted private `marker.redirect` audit and hash/count-only journal settlement.

- [ ] **Step 1: Add failing host marker-reuse test**

```js
const cached = await mutationHost.messages.findEnhancedSwipe(4, { key: 'verified-redirect-key' });
assertEqual(cached.index, 1, 'host finds verified Redirect swipe');
assertEqual(cached.text, redirectedText, 'host returns cached Redirect text');
assertDeepEqual(cached.marker, persistedRedirectMarker, 'host returns exact persisted Redirect marker');
```

- [ ] **Step 2: Add failing runtime orchestration tests**

Cover:

```js
await redirectRuntime.updateSettings({ enhancements: { mode: 'redirect', applyMode: 'replace' }, reasoningLevel: 'medium' });
const result = await redirectRuntime.enhanceLatestAssistantMessage();
assertEqual(verifierCalls.length, 1, 'Medium Redirect always verifies');
assertEqual(verifierCalls[0].request.candidateHash, hashJson(candidateText), 'runtime verifies exact candidate hash');
assertEqual(result.marker.applyMode, 'as-swipe', 'Redirect forces swipe application');
assertEqual(result.marker.verification, 'accept', 'accepted verifier status persists');
assertEqual(result.marker.redirect.characterPressure[0].character, 'Carter', 'private pressure audit persists in marker');
```

Add separate runtimes proving verifier reject, malformed accept, source change during verification, append failure, and every stable Redirect error code add no swipe and settle `status: 'error'`.

Add cache tests proving:

- key contains `verify` at all Redirect reasoning levels;
- a prior `direct` marker is not reused;
- an accepted verified marker is selected without provider calls;
- cached result returns the persisted marker/candidate hash, not `markerBase` with missing fields.

- [ ] **Step 3: Run runtime and host tests; verify RED**

```powershell
node tools/scripts/test-editorial-runtime.mjs
npm.cmd run test:host
```

Expected: FAIL because Medium Redirect is direct, candidate hash is absent, cached marker is unavailable, and private audit fields are not persisted.

- [ ] **Step 4: Return persisted markers from the host**

In `findEnhancedSwipe()`:

```js
if (markerMatchesSwipeText(markers[index], text) && markerMatches(markers[index], marker)) {
  return { index, text, marker: cloneJsonSafe(markers[index]) };
}
```

Keep marker matching and text-hash validation unchanged.

- [ ] **Step 5: Use one verification policy for cache and execution**

Before `editorialPassKey()`:

```js
const verificationRequired = editorialVerificationRequired(editorialMode, settings.reasoningLevel);
const key = editorialPassKey({
  chatKey: identity.chatKey,
  messageId,
  swipeId: identity.swipeId ?? 0,
  sourceHash,
  snapshotHash,
  mode: editorialMode,
  applyMode,
  verificationRequired
});
```

Use the same boolean for the verifier branch. Pass `mode` and request-derived `candidateHash` to `validateEditorialVerification()`.

- [ ] **Step 6: Reuse only the persisted verified marker**

```js
const existing = await messages.findEnhancedSwipe?.(messageId, markerBase);
if (existing && applyMode === 'as-swipe' && typeof messages.selectAssistantMessageSwipe === 'function') {
  const persistedMarker = asObject(existing.marker);
  if (editorialMode !== 'redirect' || persistedMarker.verification === 'accept') {
    await messages.selectAssistantMessageSwipe(messageId, existing.index, { marker: persistedMarker });
    setEditorialResult({
      mode: editorialMode,
      status: 'success',
      outcome: 'cached',
      applyMode,
      verification: persistedMarker.verification || 'cached',
      candidateHash: persistedMarker.candidateHash || ''
    });
    return { ok: true, cached: true, mode: editorialMode, marker: persistedMarker };
  }
}
```

An invalid legacy/direct marker falls through to a fresh verified run; it is not deleted.

- [ ] **Step 7: Persist private audit data and public-safe journal details**

After candidate validation and before verifier request, compute one `candidateHash`. On accepted Redirect, persist:

```js
redirect: {
  sourceFailure: diagnosisValidation.value.brief.sourceFailure,
  replacementObjective: diagnosisValidation.value.brief.replacementObjective,
  requiredBeats: diagnosisValidation.value.brief.requiredBeats,
  forbiddenSourceBeats: diagnosisValidation.value.brief.forbiddenSourceBeats,
  characterPressure: diagnosisValidation.value.brief.characterPressure
}
```

Journal details add only:

```js
redirectCharacterCount: marker.redirect?.characterPressure?.length || 0,
redirectRequiredBeatCount: marker.redirect?.requiredBeats?.length || 0
```

Do not journal pressure strings, wants, reasons, source failures, or objectives.

- [ ] **Step 8: Run focused tests and verify GREEN**

```powershell
node tools/scripts/test-editorial-runtime.mjs
npm.cmd run test:host
```

Expected: PASS.

- [ ] **Step 9: Commit runtime integration**

```powershell
git add src/runtime.mjs src/hosts/sillytavern/host.mjs tools/scripts/test-editorial-runtime.mjs tools/scripts/test-host.mjs
git commit -m "feat: integrate verified redirect runtime"
```

---

### Task 6: Lock Private Redirect Data Out of UI, Prompt, Prose, and Journal

**Files:**
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `tools/scripts/test-ui.mjs`
- Modify: `tools/scripts/test-editorial-runtime.mjs`
- Modify only if a regression fails: `src/runtime.mjs`, `src/ui.mjs`, `src/ui/view-model.mjs`

**Interfaces:**
- Consumes: private marker persisted by Task 5.
- Produces: deterministic sentinel-based privacy regressions.
- Preserves: marker availability in `swipe_info` and Recursion-owned swipe metadata.

- [ ] **Step 1: Add the sentinel fixture**

Use a literal value unlikely to occur elsewhere:

```js
const privateSentinel = 'PRIVATE_REDIRECT_PRESSURE_SENTINEL';
```

Place it in `characterPressure[0].pressureReason`, run an accepted Redirect, and capture the active message, next composed prompt packet, runtime view, rendered UI text, and journal delta.

- [ ] **Step 2: Add privacy assertions**

```js
assert(JSON.stringify(message.swipe_info[1]).includes(privateSentinel), 'private pressure remains in Recursion-owned swipe metadata');
assert(!message.swipes[1].includes(privateSentinel), 'private pressure is absent from assistant prose');
assert(!JSON.stringify(nextPromptPacket).includes(privateSentinel), 'private pressure is absent from next host prompt');
assert(!JSON.stringify(runtime.view()).includes(privateSentinel), 'private pressure is absent from visible view state');
assert(!document.body.textContent.includes(privateSentinel), 'private pressure is absent from rendered UI');
assert(!JSON.stringify(journalDelta).includes(privateSentinel), 'private pressure is absent from journal details');
```

Also assert Last Brief, inspector, tooltip titles, and status labels contain no `characterPressure`, immediate want, or pressure reason.

- [ ] **Step 3: Run privacy tests**

```powershell
node tools/scripts/test-editorial-runtime.mjs
npm.cmd run test:runtime
npm.cmd run test:ui
```

Expected: PASS if Task 5 kept private data confined. If a test fails, make the smallest boundary fix:

- remove private fields from `setEditorialResult()`/view-model projection;
- ensure prompt/context serialization uses message prose, not `extra.recursion.enhancement.redirect`;
- keep the full audit only in persisted marker metadata.

- [ ] **Step 4: Commit privacy regressions**

```powershell
git add tools/scripts/test-editorial-runtime.mjs tools/scripts/test-runtime.mjs tools/scripts/test-ui.mjs
git commit -m "test: lock redirect privacy boundaries"
```

If production files required a leak fix, include only those exact files in this commit after reviewing their pre-existing diffs.

---

### Task 7: Add a Loaded Redirect Corpus and Strict Model-Eval Harness Contract

**Files:**
- Modify: `tools/scripts/lib/model-eval-harness.mjs`
- Modify: `tools/scripts/test-model-eval-harness.mjs`
- Create: `tests/evaluation/scenarios/core/redirect-turn-deferral.json`
- Create: `tests/evaluation/scenarios/core/redirect-wrong-focus.json`
- Create: `tests/evaluation/scenarios/core/redirect-unsupported-outcome.json`
- Create: `tests/evaluation/scenarios/core/redirect-character-pressure.json`
- Create: `tests/evaluation/scenarios/core/redirect-supported-restraint.json`
- Create: `tests/evaluation/scenarios/core/redirect-insufficient-want-evidence.json`

**Interfaces:**
- Extends: `normalizeScenario()` with `oracle.editorialRedirect`.
- Changes: `runModelEval()` accepts `editorialEffectivenessRunner` dependency.
- Produces: strict non-skipped Redirect effectiveness report contract.

- [ ] **Step 1: Write failing scenario normalization tests**

Add a fixture with:

```json
{
  "id": "redirect-turn-deferral",
  "pack": "core",
  "tags": ["editorial", "redirect"],
  "snapshot": {
    "chatId": "eval-redirect-turn-deferral",
    "sceneKey": "diner-test",
    "messages": [
      { "mesid": 1, "role": "assistant", "text": "The team remains seated in the diner booth." }
    ]
  },
  "pendingUserMessage": "We should test it.",
  "settingsProfile": "auto-normal",
  "oracle": {
    "editorialRedirect": {
      "sourceResponse": "Do it, but not yet. We will use the parking lot.",
      "expectedDecision": "proceed",
      "replacementObjective": "Begin the supported test beat in this response.",
      "requiredBeats": ["The characters visibly engage the proposed test."],
      "forbiddenSourceBeats": ["Postpone the test for the parking lot."],
      "pressureExpectations": [
        { "character": "Carter", "effect": "increasing", "responseRequired": false }
      ]
    }
  }
}
```

Assert the core pack loads all six files and preserves the nested oracle.

- [ ] **Step 2: Write failing harness controls**

Inject runners that return pass, semantic fail, skipped, malformed, and no results:

```js
const report = await runModelEval({
  argv: ['--live', '--strict', '--pack', 'core', '--user', 'recursion-soak-a', '--base-url', 'http://127.0.0.1:8000', '--target-model', 'configured-target', '--judge-model', 'configured-judge'],
  editorialEffectivenessRunner: async () => ({ status: 'skipped', result: 'judge-not-run', scenarios: [] }),
  liveSmokeRunner: passingSmokeRunner
});
assertEqual(report.status, 'fail', 'strict Redirect model eval rejects a skipped judge');
```

Add empty corpus and fail-fast cases.

- [ ] **Step 3: Run and verify RED**

```powershell
npm.cmd run test:model-eval
```

Expected: FAIL because the core directory/oracle is absent and `runModelEval()` has no effectiveness runner.

- [ ] **Step 4: Extend scenario normalization**

Add:

```js
editorialRedirect: {
  sourceResponse: String(oracle.editorialRedirect?.sourceResponse || ''),
  expectedDecision: String(oracle.editorialRedirect?.expectedDecision || ''),
  replacementObjective: String(oracle.editorialRedirect?.replacementObjective || ''),
  requiredBeats: normalizeStringArray(oracle.editorialRedirect?.requiredBeats),
  forbiddenSourceBeats: normalizeStringArray(oracle.editorialRedirect?.forbiddenSourceBeats),
  pressureExpectations: Array.isArray(oracle.editorialRedirect?.pressureExpectations)
    ? oracle.editorialRedirect.pressureExpectations
    : []
}
```

Create all six scenario files with distinct positive/negative semantics from the approved spec.

- [ ] **Step 5: Add runner injection and strict settlement**

```js
export async function runModelEval({
  argv = [],
  env = process.env,
  artifactRoot = null,
  liveSmokeRunner = defaultLiveSmokeRunner,
  editorialEffectivenessRunner = defaultEditorialEffectivenessRunner
} = {}) {
  // Existing setup remains.
}
```

Filter scenarios by both tags, invoke the runner only for live non-dry execution, store `report.modelEffectiveness.redirect`, and fail strict mode on skipped, malformed, empty, or non-pass results. Remove the unconditional `model-effectiveness-not-implemented` branch for tagged Redirect runs.

- [ ] **Step 6: Run and verify GREEN**

```powershell
npm.cmd run test:model-eval
```

Expected: PASS with deterministic runner controls.

- [ ] **Step 7: Commit the harness contract and corpus**

```powershell
git add tools/scripts/lib/model-eval-harness.mjs tools/scripts/test-model-eval-harness.mjs tests/evaluation/scenarios/core
git commit -m "test: add redirect effectiveness corpus"
```

---

### Task 8: Add the Independent Redirect Effectiveness Judge

**Files:**
- Modify: `src/editorial-transform.mjs`
- Modify: `src/providers.mjs`
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-editorial-transform.mjs`
- Modify: `tools/scripts/test-providers.mjs`
- Modify: `tools/scripts/test-editorial-runtime.mjs`

**Interfaces:**
- Produces: `EDITORIAL_EFFECTIVENESS_SCHEMA = 'recursion.redirectEffectivenessJudge.v1'`.
- Produces: `buildRedirectEffectivenessRequest()` and `validateRedirectEffectiveness()`.
- Produces: internal provider role `editorialEffectivenessJudge`.
- Produces: narrow runtime method `evaluateRedirectEffectiveness(input)` for live harness use only.

- [ ] **Step 1: Write failing judge contract tests**

```js
const validJudge = {
  schema: EDITORIAL_EFFECTIVENESS_SCHEMA,
  scenarioId: 'redirect-turn-deferral',
  sourceHash,
  candidateHash,
  decision: 'pass',
  criteria: [
    { criterion: 'replacement-objective', status: 'pass', reason: 'Fulfilled.' },
    { criterion: 'forbidden-source-beats', status: 'pass', reason: 'Absent.' },
    { criterion: 'character-pressure', status: 'pass', reason: 'Coherent.' },
    { criterion: 'evidence-and-constraints', status: 'pass', reason: 'Grounded.' }
  ]
};
assertEqual(validateRedirectEffectiveness(validJudge, judgeFixture).ok, true, 'complete independent judge result passes');
assertEqual(validateRedirectEffectiveness({ ...validJudge, criteria: validJudge.criteria.slice(1) }, judgeFixture).ok, false, 'missing criterion fails');
assertEqual(validateRedirectEffectiveness({ ...validJudge, candidateHash: 'stale' }, judgeFixture).ok, false, 'judge binds candidate hash');
```

Add duplicate, unknown, malformed, and `decision: 'pass'` with failed criterion controls.

- [ ] **Step 2: Write failing provider/runtime tests**

Assert role registration, exact machine schema, and runtime call routing through the configured Utility lane. Assert provider/model diagnostics are returned so the harness can compare them to CLI expectations.

- [ ] **Step 3: Run and verify RED**

```powershell
node tools/scripts/test-editorial-transform.mjs
npm.cmd run test:providers
node tools/scripts/test-editorial-runtime.mjs
```

Expected: FAIL because schema, role, builder, validator, and runtime method do not exist.

- [ ] **Step 4: Implement request and validation**

Use exactly four criteria:

```js
export const REDIRECT_EFFECTIVENESS_CRITERIA = Object.freeze([
  'replacement-objective',
  'forbidden-source-beats',
  'character-pressure',
  'evidence-and-constraints'
]);
```

The request includes scenario oracle, frozen evidence, source, candidate, production marker hashes/status, and strict instructions not to trust the marker's self-report. Validation requires each criterion exactly once and binds scenario/source/candidate identity.

- [ ] **Step 5: Register provider role/schema**

Add `editorialEffectivenessJudge` to Utility roles and `recursion.redirectEffectivenessJudge.v1` to the role schema map. Increment `PROVIDER_CONTRACT_VERSION`. Add the exact four-criterion JSON Schema with `additionalProperties: false`.

- [ ] **Step 6: Add narrow runtime method**

```js
async function evaluateRedirectEffectiveness(input = {}) {
  const request = buildRedirectEffectivenessRequest(input);
  const response = await generationRouter.generate('editorialEffectivenessJudge', {
    ...request,
    ...reasonerRequestMetadata(settingsStore.get(), 'editorial-verify', 'utility')
  }, { runId: input.runId || makeId('redirect-eval'), retryCount: 0 });
  if (response?.ok !== true) {
    return {
      ok: false,
      error: response?.error || { code: 'RECURSION_REDIRECT_EFFECTIVENESS_FAILED', message: 'Redirect effectiveness judge failed.' },
      diagnostics: response?.diagnostics || {}
    };
  }
  return {
    ...validateRedirectEffectiveness(response.data, request),
    diagnostics: response.diagnostics || {}
  };
}
```

Expose it on the runtime object but do not call it from normal generation, settings, UI, or progress. Return provider/model diagnostics separately from judge content.

- [ ] **Step 7: Run and verify GREEN**

```powershell
node tools/scripts/test-editorial-transform.mjs
npm.cmd run test:providers
node tools/scripts/test-editorial-runtime.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit the independent judge**

```powershell
git add src/editorial-transform.mjs src/providers.mjs src/runtime.mjs tools/scripts/test-editorial-transform.mjs tools/scripts/test-providers.mjs tools/scripts/test-editorial-runtime.mjs
git commit -m "feat: add redirect effectiveness judge"
```

---

### Task 9: Build the Dedicated-User Live Redirect Runner and Strict Proof

**Files:**
- Create: `tools/scripts/lib/live-editorial-effectiveness.mjs`
- Modify: `tools/scripts/prove-live-enhancements.mjs`
- Modify: `tools/scripts/lib/model-eval-harness.mjs`
- Modify: `tools/scripts/test-model-eval-harness.mjs`
- Modify: `tools/scripts/test-live-harness.mjs`

**Interfaces:**
- Produces: `runLiveEditorialEffectiveness({ scenarios, baseUrl, user, targetModel, judgeModel, timeoutMs })`.
- Consumes: runtime `evaluateRedirectEffectiveness()` and strict live-enhancement oracle.
- Changes: model-eval default effectiveness runner delegates to this reusable live runner.

- [ ] **Step 1: Write failing live-runner boundary tests**

Test without launching a browser by injecting page/session/runtime adapters:

- unsafe user returns `unsafe-user` before browser launch;
- empty scenarios fail;
- production Redirect failure fails scenario;
- strict oracle warning/failure fails even if a swipe exists;
- missing/duplicate swipe fails;
- marker without `verification: 'accept'` or `redirect` ledger fails;
- output judge skip/malformed/fail fails;
- target/judge model mismatch fails;
- private sentinel found in visible text/prose/next prompt/journal fails;
- all healthy artifacts pass.

- [ ] **Step 2: Run and verify RED**

```powershell
npm.cmd run test:live-harness
npm.cmd run test:model-eval
```

Expected: FAIL because the reusable live runner/default integration does not exist.

- [ ] **Step 3: Implement the reusable runner**

For each scenario:

1. validate `recursion-soak-*` user;
2. open the existing authenticated SillyTavern page;
3. install the strict oracle before seeding/generation;
4. seed frozen context, pending user turn, and flawed source response into the synthetic proof chat;
5. select Redirect, call `prepareForGeneration({ userMessage: scenario.pendingUserMessage })`, then capture `const enhancementResult = await enhanceLatestAssistantMessage()`;
6. wait for diagnosis/candidate/verification/prompt-ready terminal rows;
7. capture message/swipe/marker/journal/UI/privacy artifacts;
8. call `runtime.evaluateRedirectEffectiveness()` with the fixture oracle and candidate;
9. derive scenario and process status only from strict oracle + host mutation + independent judge.

Return:

```js
{
  status: 'pass',
  result: 'redirect-effectiveness-passed',
  scenarios: [{
    scenarioId,
    sourceHash,
    candidateHash,
    productionVerification: marker.verification,
    verifierChecks: enhancementResult.verification.checks,
    judge: judgeResult,
    provider: { targetModel: targetDiagnostics.model, judgeModel: judgeDiagnostics.model },
    oracle: oracle.verdict
  }]
}
```

- [ ] **Step 4: Refactor the existing live Enhancement proof to use the runner**

Keep the Standard/Rapid/Fused matrix and existing strict oracle. Replace duplicated Redirect scenario setup with the shared runner. Do not weaken current Repair/Recompose cases.

- [ ] **Step 5: Connect the model-eval default runner**

```js
async function defaultEditorialEffectivenessRunner(options) {
  const { runLiveEditorialEffectiveness } = await import('./live-editorial-effectiveness.mjs');
  return runLiveEditorialEffectiveness(options);
}
```

Pass `baseUrl`, user, expected models, timeout, filtered scenarios, and environment from `runModelEval()`.

- [ ] **Step 6: Run deterministic tests and verify GREEN**

```powershell
npm.cmd run test:live-harness
npm.cmd run test:model-eval
```

Expected: PASS.

- [ ] **Step 7: Commit the live runner**

```powershell
git add tools/scripts/lib/live-editorial-effectiveness.mjs tools/scripts/prove-live-enhancements.mjs tools/scripts/lib/model-eval-harness.mjs tools/scripts/test-model-eval-harness.mjs tools/scripts/test-live-harness.mjs
git commit -m "test: prove redirect semantics live"
```

---

### Task 10: Update Architecture Docs and Run the Full Verification Ladder

**Files:**
- Modify: `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`
- Modify: `docs/testing/TESTING_STRATEGY.md`
- Modify: `docs/superpowers/specs/2026-07-13-recursion-editorial-transformation-design.md`
- Modify if implementation differed: `docs/superpowers/specs/2026-07-15-recursion-redirect-improvement-design.md`

**Interfaces:**
- Documents: exact Redirect diagnosis/verification/effectiveness roles, privacy boundary, cache identity, error/status behavior, test commands, and dedicated-user live requirements.
- Produces: final deterministic, full-suite, installed-copy, and live evidence.

- [ ] **Step 1: Update docs from actual implementation**

Document exact exported names, schema fields, error codes, provider roles, marker shape, journal counts, and commands. Cross-link the improvement spec from the older Editorial design and state that its Redirect sections are superseded.

- [ ] **Step 2: Run every focused deterministic gate**

```powershell
npm.cmd run test:providers
node tools/scripts/test-provider-response-parser.mjs
node tools/scripts/test-editorial-transform.mjs
node tools/scripts/test-editorial-runtime.mjs
npm.cmd run test:host
npm.cmd run test:runtime
npm.cmd run test:ui
npm.cmd run test:model-eval
npm.cmd run test:live-harness
```

Expected: every command exits 0 with no failed assertions.

- [ ] **Step 3: Run the full repository suite**

```powershell
npm.cmd test
```

Expected: all discovered test scripts pass; no warnings/errors are treated as success.

- [ ] **Step 4: Sync only to the dedicated soak extension and hash-check it**

Use the existing dedicated-user copy, never `default-user`:

```powershell
robocopy F:\git\Recursion F:\SillyTavern\SillyTavern\data\recursion-soak-a\extensions\Recursion /E /XD .git node_modules artifacts .tmp tests /XF debug.log
```

Treat robocopy exit codes `0` through `7` as success. Compare SHA-256 hashes for at least:

```text
src/editorial-transform.mjs
src/providers.mjs
src/runtime.mjs
src/hosts/sillytavern/host.mjs
tools are not served and are not copied
```

Expected: repo and installed-copy hashes match for every served source file.

- [ ] **Step 5: Run the real-model Redirect proof**

Prerequisites: SillyTavern is running at `http://127.0.0.1:8000`, `recursion-soak-a` exists, and `RECURSION_MODEL_EVAL_TARGET_MODEL` / `RECURSION_MODEL_EVAL_JUDGE_MODEL` name the models configured in that user's live providers.

```powershell
$env:SILLYTAVERN_BASE_URL='http://127.0.0.1:8000'
$env:RECURSION_SILLYTAVERN_USER='recursion-soak-a'
npm.cmd run prove:enhancements-live
npm.cmd run test:model-eval -- --live --strict --pack core --user recursion-soak-a --base-url http://127.0.0.1:8000 --target-model $env:RECURSION_MODEL_EVAL_TARGET_MODEL --judge-model $env:RECURSION_MODEL_EVAL_JUDGE_MODEL
```

Expected:

- no caution, warning, failed, or skipped success observation;
- diagnosis, candidate, verification, and prompt-ready rows finish done;
- each successful Redirect appends/selects exactly one verified swipe;
- OV-1-style condensation fails semantic acceptance;
- supported-restraint scenario passes without forced action;
- private sentinel is absent from UI/prose/next prompt/journal;
- output judge runs and reports all four criteria pass;
- process exits 0 only when every oracle is healthy.

- [ ] **Step 6: Review final diff and commit docs/closeout**

```powershell
git diff --check
git status --short
git add docs/architecture/PROVIDER_AND_GENERATION_SPEC.md docs/testing/TESTING_STRATEGY.md docs/superpowers/specs/2026-07-13-recursion-editorial-transformation-design.md docs/superpowers/specs/2026-07-15-recursion-redirect-improvement-design.md
git commit -m "docs: finalize redirect verification contract"
```

If the full suite or live proof fails, do not commit a success closeout or report completion. Return to the first failing focused task, add or strengthen the regression, and repeat the verification ladder.

## Completion Audit

Before declaring the feature complete, map evidence to every approved acceptance criterion:

1. Redirect proceed requires source failure, replacement objective, required/forbidden beats, and complete pressure map.
2. Concrete wants cite only non-source frozen evidence.
3. Pressure remains advisory, including supported silence/restraint.
4. Redirect candidate requires evidence-backed `redirect` ledger.
5. One shared policy controls cache identity and verification execution.
6. Verification requires eight exact passing checks and exact candidate identity.
7. OV-1 condensation creates no accepted Redirect swipe.
8. Valid Redirect creates/selects one swipe.
9. Verified cache reuse returns the persisted accepted marker without provider calls.
10. Private metadata is absent from all prohibited surfaces.
11. Core-pack independent output judge executes; skipped/empty is failure.
12. Focused, full, and live gates pass.
13. Installed dedicated-user source hashes match the repository.

Record the command, exit code, and relevant artifact/report path for each item. Repository tests alone are not completion evidence for items 7, 11, 12, or 13.
