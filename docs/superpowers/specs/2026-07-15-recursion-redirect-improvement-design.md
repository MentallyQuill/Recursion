# Recursion Redirect Improvement Design

## Status

**Approved design direction; implementation pending.**

This document supplements the [Editorial Transformation Design](2026-07-13-recursion-editorial-transformation-design.md). Where the two documents conflict, this document supersedes only the diagnosis, transformation, validation, verification, persistence, and test contracts for `Redirect`. `Repair` and `Recompose` remain unchanged.

## Problem

Redirect is intended to write the response a turn should have received when the completed assistant response is fundamentally pointed in the wrong direction. The current product description says that clearly, but the runtime contract does not enforce it.

The latest OV-1 failure demonstrated the gap:

- The user said that the characters should test the transport method.
- The installed Scene Frame said not to skip the pattern-drawing demonstration.
- The source deferred the test and moved the scene toward a later parking-lot test.
- Redirect preserved the same objective, beat order, deferral, and ending.
- Its change ledger contained only `reorder` entries describing condensation and streamlining.
- It still reported every installed card as `honored` and passed as a Redirect.

The existing full-candidate validator treats Recompose and Redirect alike. A candidate can pass Redirect by being non-identical, bounded, schema-valid, and evidence-referenced even when it preserves the source's wrong dramatic direction.

## Product decision

Redirect becomes a turn-level correction contract, not a more aggressive synonym for Recompose.

| Mode | Preserved | Rebuilt |
| --- | --- | --- |
| `Recompose` | Supported turn intent and direction | Execution, prose, staging, sequence, pacing, and dialogue |
| `Redirect` | Frozen facts, commitments, constraints, reveal boundaries, and supported character state | The source's unsupported objective, dramatic focus, beat plan, and response to the user turn |

A Redirect may be similar in length or wording to its source. Its required difference is **trajectory**, not edit distance. Conversely, a large lexical rewrite that preserves the same wrong objective is not a Redirect.

Redirect remains:

- one diagnosis;
- one candidate, with one existing semantic correction attempt if structurally invalid;
- one accept/reject verifier;
- always applied as a new swipe;
- non-destructive to the original assistant response.

## Goals

1. Make the diagnostician state exactly why the source is pointed the wrong way.
2. Give the transformer an evidence-backed replacement objective and beat boundary.
3. Analyze each present character's immediate want and how the source affects pressure on that want.
4. Use character pressure as advisory generation evidence, not a mandatory action checklist.
5. Reject Redirect candidates that merely condense, polish, or lightly reorder the source.
6. Require independent semantic verification for every Redirect, regardless of reasoning level.
7. Keep character-pressure analysis private to Recursion's diagnosis, transformer, verifier, and audit metadata.
8. Add deterministic, model-evaluation, and live regressions that reproduce the OV-1 failure.

## Non-goals

- No numeric tension or pressure score.
- No requirement that pressure increase.
- No requirement that every character speak or act.
- No visible character-pressure panel or inspector section.
- No multi-candidate tournament or verifier-authored rewrite.
- No graph memory, embeddings, durable character psychology, or transcript-wide retrieval.
- No change to Repair or Recompose semantics.
- No automatic escalation from Recompose to Redirect.

## Runtime flow

```text
Frozen user turn + context + Prompt Packet + installed cards + source response
                                  |
                         Redirect diagnosis
                                  |
              source failure + replacement objective
              required beats + forbidden source beats
              present-character pressure map
                                  |
                         Redirect transformer
                                  |
               one complete candidate + redirect ledger
                                  |
                    deterministic validation
                                  |
                    mandatory Redirect verifier
                                  |
                  accept -> append one new swipe
                  reject -> keep original unchanged
```

The diagnosis is authoritative. The transformer may decide how to express the replacement objective, but it may not silently replace the objective, preserve a forbidden source beat, or invent a different character motivation.

## Redirect diagnosis contract

Redirect receives mode-specific diagnosis fields in addition to the existing identity fields and general preservation ledger.

```js
const REDIRECT_FAILURE_CATEGORIES = new Set([
  'turn-fulfillment',
  'core-direction',
  'hard-constraint',
  'unsupported-outcome',
  'temporal-causal',
  'character-epistemic'
]);

const REDIRECT_PRESSURE_EFFECTS = new Set([
  'increasing',
  'decreasing',
  'unchanged',
  'unclear'
]);

// Shape documented as JavaScript because Recursion is implemented as .mjs.
const redirectBrief = {
  mode: 'redirect',
  diagnosis: [],
  preserve: [],
  discard: [],
  allowedChanges: [],
  forbiddenChanges: [],

  sourceFailure: {
    category: 'turn-fulfillment',
    problem: 'The source acknowledges the requested test but postpones it.',
    establishedEvidenceRefs: ['user:0', 'card:sceneframecard:beatconstraint'],
    conflictingSourceRefs: ['source:0', 'source:3']
  },

  replacementObjective: {
    summary: 'Respond to the request by moving the present scene into the supported test beat.',
    evidenceRefs: ['user:0', 'card:sceneframecard:beatconstraint']
  },

  requiredBeats: [
    {
      summary: 'The characters visibly engage with beginning the proposed test.',
      evidenceRefs: ['user:0', 'card:sceneframecard:beatconstraint']
    }
  ],

  forbiddenSourceBeats: [
    {
      summary: 'Do not preserve the decision to postpone the test for a later location.',
      sourceRefs: ['source:3']
    }
  ],

  sceneCharacters: [
    { character: 'Carter', evidenceRefs: ['card:activecastcard:presentcharacters'] }
  ],

  characterPressure: [
    {
      character: 'Carter',
      immediateWant: 'Test and understand the transport mechanism directly.',
      wantEvidenceRefs: ['user:0', 'card:activecastcard:speakerroles'],
      sourcePressureEffect: 'increasing',
      sourceEvidenceRefs: ['source:0', 'source:3'],
      pressureReason: 'The source raises the possibility of testing, then blocks the requested test.'
    }
  ]
};
```

### Proceed and no-change

For `decision: "proceed"`:

- `sourceFailure` and `replacementObjective` are non-null.
- `requiredBeats` and `forbiddenSourceBeats` are non-empty.
- `sceneCharacters` and `characterPressure` contain the same unique character names.
- Every concrete want has authoritative evidence.
- Every claimed source pressure effect cites source-draft evidence.

For `decision: "no-change"`:

- `sourceFailure` and `replacementObjective` are `null`.
- `requiredBeats` and `forbiddenSourceBeats` are empty.
- The pressure map may still contain `unclear` entries that explain why no supported turn-level replacement can be established.

Insufficient evidence produces `no-change`. It never licenses the transformer to invent a more dramatic alternative.

## Character-pressure analysis

The diagnostician answers two private questions for every character established as present by frozen evidence:

1. What does this character want in this moment?
2. Does the source response increase, decrease, preserve, or leave unclear the pressure on that want?

### Evidence rules

- Character presence and immediate wants cite only authoritative evidence: user turn, prior context, Prompt Packet, installed cards, Last Brief, or story form.
- Source-draft passages may show how the response affected pressure, but cannot establish the underlying want.
- A concrete want without authoritative evidence fails diagnosis validation.
- When the want cannot be established, `immediateWant` is `null`, `wantEvidenceRefs` is empty, and `sourcePressureEffect` is `unclear`.
- `sceneCharacters` provides the coverage list. Runtime validates that `characterPressure` contains exactly one row for each listed character.
- The mandatory verifier checks whether the diagnostician omitted a clearly present character from `sceneCharacters`.

### Generation guidance

Pressure is advisory evidence:

- `increasing`: make a stronger visible response, interruption, objection, decision, action, refusal, or deliberate restraint more likely when supported.
- `decreasing`: allow relief, concession, recalibration, or redirected attention to become visible.
- `unchanged`: do not manufacture a reaction solely to service the pressure map.
- `unclear`: preserve ambiguity and do not invent motivation.

Silence, restraint, refusal, or delayed action can be the strongest supported response. Redirect is not required to increase pressure, change every character's pressure, or give every character a line.

The transformer prompt should state this directly:

```js
const redirectPressureRule = [
  'Use diagnosis.brief.characterPressure as advisory dramatic evidence.',
  'When the source increases pressure on a supported immediate want, make a stronger visible response or action more likely, but do not force one.',
  'Silence, restraint, refusal, or delayed action remain valid when frozen evidence supports them.',
  'Do not distribute dialogue or action as a checklist, and do not invent a want for an unclear character.'
].join(' ');
```

## Evidence-pair adaptation

The prior assessment of [Lost in Stories](https://arxiv.org/html/2603.05890) identified a useful ConStory-Checker pattern: findings should pair established evidence with the conflicting response passage. Redirect adopts that pattern as an improvement mechanism rather than a score.

```text
Established evidence
        +
Conflicting source passage
        +
Replacement objective
        =
Actionable Redirect diagnosis
```

This keeps `sourceFailure` auditable and separates continuity evidence from editable prose. The source can prove what went wrong; it cannot prove what must remain true.

The design also adopts an explicit insufficient-evidence state. It does not adopt the paper's full multi-stage checker, abandoned-plot detection, or category-per-call architecture.

[MemCoT](https://arxiv.org/html/2604.08216v1)'s bounded narrow-to-wide evidence lens remains a possible future improvement when a character want depends on older in-scene evidence outside the provider snapshot. It is not part of this Redirect change. Redirect must use the frozen evidence it receives and return `no-change` when that evidence is insufficient.

## Provider schema integration

`src/providers.mjs` should extend `editorialBriefSchema()` only when `mode === "redirect"`. Recompose retains the current brief shape.

```js
function redirectPressureSchema(validEvidenceIds, validPreservationEvidenceIds) {
  return {
    type: 'object',
    properties: {
      character: { type: 'string' },
      immediateWant: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      wantEvidenceRefs: editorialEvidenceRefsSchema(validPreservationEvidenceIds),
      sourcePressureEffect: { enum: ['increasing', 'decreasing', 'unchanged', 'unclear'] },
      sourceEvidenceRefs: editorialEvidenceRefsSchema(validEvidenceIds),
      pressureReason: { type: 'string' }
    },
    required: [
      'character',
      'immediateWant',
      'wantEvidenceRefs',
      'sourcePressureEffect',
      'sourceEvidenceRefs',
      'pressureReason'
    ],
    additionalProperties: false
  };
}

function redirectBriefProperties(validEvidenceIds, validPreservationEvidenceIds) {
  const evidenceRefs = editorialEvidenceRefsSchema(validEvidenceIds);
  const authoritativeRefs = editorialEvidenceRefsSchema(validPreservationEvidenceIds);
  return {
    sourceFailure: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            category: { enum: [...REDIRECT_FAILURE_CATEGORIES] },
            problem: { type: 'string' },
            establishedEvidenceRefs: authoritativeRefs,
            conflictingSourceRefs: evidenceRefs
          },
          required: ['category', 'problem', 'establishedEvidenceRefs', 'conflictingSourceRefs'],
          additionalProperties: false
        }
      ]
    },
    replacementObjective: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: { summary: { type: 'string' }, evidenceRefs: authoritativeRefs },
          required: ['summary', 'evidenceRefs'],
          additionalProperties: false
        }
      ]
    },
    requiredBeats: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        properties: { summary: { type: 'string' }, evidenceRefs: authoritativeRefs },
        required: ['summary', 'evidenceRefs'],
        additionalProperties: false
      }
    },
    forbiddenSourceBeats: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        properties: { summary: { type: 'string' }, sourceRefs: evidenceRefs },
        required: ['summary', 'sourceRefs'],
        additionalProperties: false
      }
    },
    sceneCharacters: {
      type: 'array',
      minItems: 1,
      maxItems: 16,
      items: {
        type: 'object',
        properties: { character: { type: 'string' }, evidenceRefs: authoritativeRefs },
        required: ['character', 'evidenceRefs'],
        additionalProperties: false
      }
    },
    characterPressure: {
      type: 'array',
      minItems: 1,
      maxItems: 16,
      items: redirectPressureSchema(validEvidenceIds, validPreservationEvidenceIds)
    }
  };
}
```

Provider JSON Schema constrains shape and permitted references. Runtime semantic validation remains authoritative for reference authority, proceed/no-change consistency, character coverage, and source-only fields.

## Diagnosis validation

`src/editorial-transform.mjs` should add Redirect-only semantic validation after the existing general brief validation.

```js
function validateRedirectBrief(brief, evidence, decision) {
  const known = evidenceMap(evidence);
  const isSource = (id) => ['source-draft', 'source-negative'].includes(known.get(id)?.authority);
  const authoritative = (ids) => ids.length > 0 && ids.every((id) => known.has(id) && !isSource(id));
  const sourceOnly = (ids) => ids.length > 0 && ids.every((id) => known.has(id) && isSource(id));

  if (decision === 'no-change') {
    if (brief.sourceFailure !== null || brief.replacementObjective !== null) return failRedirectBrief();
    if (brief.requiredBeats.length || brief.forbiddenSourceBeats.length) return failRedirectBrief();
  } else {
    if (!brief.sourceFailure || !brief.replacementObjective) return failRedirectBrief();
    if (!authoritative(brief.sourceFailure.establishedEvidenceRefs)) return failRedirectEvidence();
    if (!sourceOnly(brief.sourceFailure.conflictingSourceRefs)) return failRedirectEvidence();
    if (!authoritative(brief.replacementObjective.evidenceRefs)) return failRedirectEvidence();
    if (!brief.requiredBeats.length || !brief.forbiddenSourceBeats.length) return failRedirectBrief();
    if (brief.requiredBeats.some((beat) => !authoritative(beat.evidenceRefs))) return failRedirectEvidence();
    if (brief.forbiddenSourceBeats.some((beat) => !sourceOnly(beat.sourceRefs))) return failRedirectEvidence();
  }

  const characters = brief.sceneCharacters.map((entry) => entry.character.trim());
  const pressureCharacters = brief.characterPressure.map((entry) => entry.character.trim());
  if (characters.some((character) => !character)) return failRedirectCharacters();
  if (brief.sceneCharacters.some((entry) => !authoritative(entry.evidenceRefs))) return failRedirectEvidence();
  if (new Set(characters).size !== characters.length) return failRedirectCharacters();
  if (hashJson([...characters].sort()) !== hashJson([...pressureCharacters].sort())) return failRedirectCharacters();

  for (const row of brief.characterPressure) {
    if (row.immediateWant === null) {
      if (row.wantEvidenceRefs.length || row.sourceEvidenceRefs.length || row.sourcePressureEffect !== 'unclear') {
        return failRedirectPressure();
      }
      continue;
    }
    if (!authoritative(row.wantEvidenceRefs)) return failRedirectEvidence();
    if (!sourceOnly(row.sourceEvidenceRefs)) return failRedirectEvidence();
  }

  return { ok: true, value: brief };
}
```

The exact helper names may follow local conventions, but these checks are required behavior, not illustrative optionality.

## Transformer contract

The Redirect transformer receives the validated diagnosis unchanged and writes one complete candidate. Its prompt must distinguish trajectory from prose variance.

```js
const redirectRules = [
  'The validated Redirect diagnosis is authoritative.',
  'Rebuild the response around diagnosis.brief.replacementObjective.',
  'Include the supported substance of every required beat.',
  'Do not preserve any forbidden source beat, even with different wording.',
  'Treat source passages named by sourceFailure or forbiddenSourceBeats as negative evidence.',
  redirectPressureRule,
  'Preserve only frozen facts, commitments, constraints, reveal boundaries, and supported character state.',
  'A lexical rewrite that preserves the source objective or beat plan is not a Redirect.'
];
```

Redirect may retain an unaffected sentence when the diagnosis permits it. It does not need to maximize edit distance. It does need to produce the replacement turn described by the diagnosis.

## Candidate validation

The existing full-candidate checks remain necessary but are not sufficient for Redirect.

Deterministic Redirect validation additionally requires:

- exactly one full candidate and no patches;
- a candidate different from the source;
- a change ledger containing at least one `kind: "redirect"` entry;
- every Redirect ledger entry citing at least one authoritative objective or required-beat evidence reference;
- exact diagnosis hash identity;
- exact preservation ledger identity;
- complete installed-card outcome coverage;
- mandatory verifier execution before host mutation.

```js
if (mode === 'redirect') {
  const redirects = data.candidate.changeLedger.filter((entry) => entry.kind === 'redirect');
  if (!redirects.length) {
    return fail(
      'RECURSION_EDITORIAL_REDIRECT_MISSING',
      'Redirect candidate did not report a turn-level directional change.'
    );
  }
  const objectiveRefs = new Set([
    ...diagnosis.brief.replacementObjective.evidenceRefs,
    ...diagnosis.brief.requiredBeats.flatMap((beat) => beat.evidenceRefs)
  ]);
  if (redirects.some((entry) => !entry.evidenceRefs.some((id) => objectiveRefs.has(id)))) {
    return fail(
      'RECURSION_EDITORIAL_REDIRECT_EVIDENCE_INVALID',
      'Redirect ledger did not cite its validated replacement objective.'
    );
  }
}
```

This deterministic check blocks the OV-1 candidate's all-`reorder` ledger. It does not attempt to prove prose semantics. That remains the verifier's job.

## Mandatory Redirect verification

Every Redirect receives one independent verifier call. Recompose retains its existing High/Ultra-only verification policy.

```js
const verificationRequired = editorialMode === 'redirect'
  || ((settings.reasoningLevel === 'high' || settings.reasoningLevel === 'ultra')
    && editorialMode === 'recompose');

if (verificationRequired) {
  // Existing one-candidate accept/reject verification path.
}
```

The verifier returns no prose and cannot request another candidate. It evaluates these checks exactly once each:

```js
const REDIRECT_VERIFICATION_CHECKS = Object.freeze([
  'source-failure-removed',
  'replacement-objective-fulfilled',
  'required-beats-satisfied',
  'forbidden-source-beats-excluded',
  'character-pressure-coherent',
  'hard-constraints-preserved',
  'user-turn-answered',
  'unsupported-facts-absent'
]);

const verification = {
  schema: 'recursion.editorialVerification.v1',
  decision: 'accept',
  checks: REDIRECT_VERIFICATION_CHECKS.map((check) => ({
    check,
    status: 'pass',
    evidenceRefs: ['user:0'],
    note: 'Concise evidence-bound result.'
  }))
};
```

An `accept` result is valid only when every required check is present exactly once and has `status: "pass"`. Any `fail`, `unclear`, missing check, unknown evidence reference, or malformed result rejects the candidate and preserves the original.

`character-pressure-coherent` does **not** require visible action. It asks whether the candidate used, preserved, or intentionally withheld response in a way consistent with the evidence-backed wants and pressure map.

## Private persistence contract

The character-pressure map is private Recursion data for V1.

It may be persisted under the Recursion-owned enhancement marker so tests and diagnostics can audit the run:

```js
const marker = {
  ...markerBase,
  diagnosisHash,
  candidateHash,
  verification: 'accept',
  redirect: {
    sourceFailure: diagnosis.brief.sourceFailure,
    replacementObjective: diagnosis.brief.replacementObjective,
    requiredBeats: diagnosis.brief.requiredBeats,
    forbiddenSourceBeats: diagnosis.brief.forbiddenSourceBeats,
    characterPressure: diagnosis.brief.characterPressure
  }
};
```

Private means:

- not displayed in the Editorial inspector;
- not rendered in Last Brief;
- not inserted into the assistant response;
- not installed into SillyTavern's next-generation prompt;
- not exposed as visible explanatory text;
- available only to the current Redirect transformer, verifier, persisted Recursion metadata, run journal hashes/status, and automated tests.

The run journal should record hashes, counts, and terminal status rather than duplicate the full private map.

## UI and progress

No new visible control or panel is added.

Existing Redirect progress remains:

```text
Redirect diagnosis
Redirect candidate
Redirect verification
```

Redirect cannot show success until:

1. the diagnosis validates;
2. the candidate validates;
3. mandatory verification accepts;
4. the host confirms that the new swipe was appended and selected.

A rejected verifier is a failed Redirect, not a caution followed by a green success tree.

## Error behavior

| Condition | Result |
| --- | --- |
| Diagnosis has insufficient evidence | `no-change`; original kept; no transformer call |
| Diagnosis omits required Redirect fields | One semantic diagnosis correction; then fail |
| Character map invents an unsupported want | One semantic diagnosis correction; then fail |
| Candidate has no `redirect` ledger entry | One semantic transform correction; then fail |
| Candidate preserves forbidden source direction | Verifier rejects; original kept |
| Verifier omits or cannot resolve a required check | Verification fails; original kept |
| Active source swipe changes before commit | Existing stale-source failure; no mutation |
| Host swipe append fails or does not settle | Run fails; never report success |

Verifier rejection does not trigger another writer call. Redirect remains one candidate, not an iterative generation loop.

## Test design

### 1. Diagnosis schema and semantic validation

Extend `tools/scripts/test-editorial-transform.mjs` with focused Redirect cases:

```js
assertEqual(
  validateEditorialDiagnosis(redirectWithoutObjective, redirectFixture).ok,
  false,
  'Redirect proceed requires a replacement objective'
);

assertEqual(
  validateEditorialDiagnosis(redirectWithSourceBackedWant, redirectFixture).ok,
  false,
  'Redirect cannot derive a character want from the editable source draft'
);

assertEqual(
  validateEditorialDiagnosis(redirectWithUnclearWant, redirectFixture).ok,
  true,
  'Redirect permits an evidence-insufficient character want without invention'
);
```

Required negative controls:

- missing `sourceFailure`;
- missing `replacementObjective`;
- empty required or forbidden beats on `proceed`;
- authoritative claim citing `source:N`;
- conflicting source passage citing non-source evidence;
- duplicate or mismatched character coverage;
- concrete want without authoritative evidence;
- unclear want paired with a concrete pressure effect.

Recompose fixtures must continue to validate without Redirect-only fields.

### 2. Candidate distinction

The latest OV-1 behavior becomes a deterministic regression fixture:

```js
const ov1 = {
  userTurn: 'We should test it.',
  requiredBeat: 'Do not skip the pattern drawing demonstration.',
  source: 'Do it. But not yet. Not here. We go back to the parking lot.',
  minorRewrite: 'Do it, but not yet. Not here. We will use the parking lot.'
};

assertEqual(
  validateEditorialPass(redirectPass({
    text: ov1.minorRewrite,
    changeLedger: [{ kind: 'reorder', summary: 'Condensed the directive.', evidenceRefs: ['source:0'] }]
  }), redirectFixture).ok,
  false,
  'Redirect rejects a Recompose-style condensation with no directional change ledger'
);
```

Add a lying-ledger negative control whose candidate uses `kind: "redirect"` but preserves the same deferral. Deterministic validation may accept its structure; the mandatory verifier fixture must reject `forbidden-source-beats-excluded` and runtime must not append a swipe.

### 3. Pressure remains advisory

Add fixtures proving:

- increasing pressure can support a stronger spoken response;
- increasing pressure can support deliberate silence or restraint;
- decreasing pressure can produce relief or recalibration;
- unchanged pressure does not force a character beat;
- unclear pressure does not invent motivation;
- not every present character needs dialogue or action.

The acceptance condition is coherence with evidence, not maximum visible reaction.

### 4. Runtime verification policy

Extend `tools/scripts/test-editorial-runtime.mjs`:

```js
await runtime.updateSettings({ enhancements: { mode: 'redirect', applyMode: 'as-swipe' }, reasoningLevel: 'medium' });
await runtime.enhanceLatestAssistantMessage();

assertEqual(verifierCalls.length, 1, 'Redirect always verifies at Medium');
assertEqual(message.swipes.length, 2, 'accepted Redirect appends exactly one swipe');
assertEqual(message.swipeId, 1, 'accepted Redirect selects the appended swipe');
```

Also prove:

- a rejected Redirect verifier leaves one original swipe;
- a malformed verifier result leaves one original swipe;
- success is not visible before host append settlement;
- Recompose at Medium does not gain mandatory verification;
- Redirect never honors a requested Replace apply mode.

### 5. Model-effectiveness corpus

Add fixed Redirect scenarios under `tests/evaluation/scenarios/editorial/`:

- `redirect-turn-deferral.json`: the OV-1 test-now versus postpone failure;
- `redirect-wrong-focus.json`: source answers atmosphere instead of the user's action;
- `redirect-unsupported-outcome.json`: source resolves an outcome the user did not establish;
- `redirect-character-pressure.json`: rising pressure supports a stronger response;
- `redirect-supported-restraint.json`: rising pressure is answered through supported silence/restraint;
- `redirect-insufficient-want-evidence.json`: no-change rather than invented motivation.

The judge must evaluate trajectory and evidence, not lexical distance. The same minor rewrite may be a possible Recompose but must fail the Redirect objective.

### 6. Live Playwright proof

The dedicated live Enhancement proof should use a `recursion-soak-*` account and a fixed user turn whose source visibly defers a required action. A successful Redirect requires:

- healthy diagnosis, candidate, verification, and prompt-ready progress;
- no historical caution, warning, failure, or skipped success state;
- one new Recursion-owned swipe;
- a marker with `mode: "redirect"`, `verification: "accept"`, and at least one `redirect` ledger entry;
- private Redirect metadata present but absent from visible UI and final prose;
- semantic judge acceptance that the replacement objective was fulfilled and the forbidden source beat was removed.

The script exit code must derive from the strict live-enhancement oracle plus the Redirect semantic judge. A green progress tree alone is not proof of a successful Redirect.

## Integration map

Implementation should update these existing boundaries in place:

| File | Responsibility |
| --- | --- |
| `src/providers.mjs` | Redirect-only diagnosis and verification schemas |
| `src/editorial-transform.mjs` | Redirect brief validation, pressure validation, prompt rules, candidate ledger validation |
| `src/runtime.mjs` | Mandatory Redirect verification, private marker persistence, terminal settlement |
| `tools/scripts/test-editorial-transform.mjs` | Diagnosis, evidence authority, character coverage, and candidate negative controls |
| `tools/scripts/test-editorial-runtime.mjs` | Verification policy and host mutation behavior |
| `tools/scripts/prove-live-enhancements.mjs` | Mode-specific Redirect semantic acceptance |
| `tests/evaluation/scenarios/editorial/*.json` | Fixed Redirect and pressure scenarios |
| `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md` | Provider-role and verification contract |
| `docs/testing/TESTING_STRATEGY.md` | Redirect semantic and live gates |
| `docs/superpowers/specs/2026-07-13-recursion-editorial-transformation-design.md` | Cross-reference this superseding Redirect contract |

No compatibility shim is required. Recursion is pre-alpha; schemas, fixtures, docs, and examples should move together to the coherent Redirect contract.

## Acceptance criteria

The implementation is complete only when:

1. Redirect `proceed` cannot validate without a source failure, replacement objective, required beats, forbidden source beats, and complete character-pressure map.
2. Every concrete character want is backed by non-source frozen evidence.
3. Character pressure guides generation but does not require action, speech, or increased pressure.
4. A Redirect candidate without an evidence-backed `redirect` ledger entry fails before host mutation.
5. Every Redirect receives an independent verifier call at all reasoning levels.
6. The OV-1 condensation candidate fails Redirect and creates no swipe.
7. A valid materially redirected candidate creates and selects exactly one swipe.
8. Private pressure metadata never appears in visible UI, final prose, Last Brief, or the next host prompt.
9. Focused tests, `npm.cmd test`, the model-effectiveness Redirect corpus, and the dedicated live Playwright proof pass.
10. The served or installed SillyTavern extension copy is hash-checked before any live success claim.
