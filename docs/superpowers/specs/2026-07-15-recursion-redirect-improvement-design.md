# Recursion Redirect Improvement Design

## Status

**Implemented.** The provider contract, semantic validators, runtime/cache integration,
private marker boundary, core evaluation corpus, independent effectiveness judge, and
strict dedicated-user Playwright proof now implement this design.

Implementation and deterministic verification are complete. Live certification is
still an execution gate, not a status inferred from this heading: a release proof
must produce one clean strict run on the configured provider. Individual clean mode
runs do not override token-limit, timeout, malformed-output, or semantic failures in
another strict run.

This document supplements the [Editorial Transformation Design](2026-07-13-recursion-editorial-transformation-design.md). Where the two documents conflict, this document supersedes only the diagnosis, transformation, validation, verification, persistence, and test contracts for `Redirect`. `Repair` and `Recompose` remain unchanged.

Implementation clarification: when a character's immediate want is `unclear`, the
provider must return empty `wantEvidenceRefs` and `sourceEvidenceRefs`, and the
pressure effect must also be `unclear`. This prevents an uncertainty finding from
claiming evidence it does not possess. An explicit Redirect accepts only `proceed`;
an invalid or insufficient diagnosis receives one correction attempt and then fails
visibly without mutating the host response.

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

### Proceed-only Redirect

Every valid Redirect diagnosis uses `decision: "proceed"`:

- `sourceFailure` and `replacementObjective` are non-null.
- `requiredBeats` and `forbiddenSourceBeats` are non-empty.
- `sceneCharacters` and `characterPressure` contain the same unique character names.
- Every concrete want has authoritative evidence.
- Every claimed source pressure effect cites source-draft evidence.

The provider may still mark a character's immediate want and pressure effect as
`unclear`, but that uncertainty does not cancel the explicit Redirect. The diagnosis
must identify the strongest evidence-supported correction elsewhere in the frozen
turn. If it cannot satisfy the contract after one correction request, runtime fails
red and preserves the original response rather than inventing unsupported content.

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

The design keeps uncertainty explicit at the character-pressure field level. It does not adopt the paper's full multi-stage checker, abandoned-plot detection, or category-per-call architecture.

[MemCoT](https://arxiv.org/html/2604.08216v1)'s bounded narrow-to-wide evidence lens remains a possible future improvement when a character want depends on older in-scene evidence outside the provider snapshot. It is not part of this Redirect change. Redirect must use the frozen evidence it receives; unresolved character wants remain `unclear`, while an unsatisfied overall diagnosis contract fails visibly after correction.

## Provider schema integration

> Implementation amendment, 2026-07-16: the nested mixed-mode Redirect brief described below was replaced after repeated Utility-only provider failures showed semantic fields being shifted into `brief.mode`, generic diagnosis arrays, and other unrelated slots. The code snippets below remain as design history for the internal canonical brief, not the provider response shape.

The provider-facing Redirect diagnosis is now flat and mode-specific. It returns the frozen identity fields plus `sourceFailure`, `replacementObjective`, `requiredBeats`, `forbiddenSourceBeats`, `sceneCharacters`, and `characterPressure` at the top level. It does not return `brief`, `diagnosis`, `preserve`, `discard`, `allowedChanges`, or `forbiddenChanges`. Runtime validates the flat result and then constructs the private canonical `diagnosis.brief` used by Transform, Verify, markers, and audit logic. Recompose and Repair retain the generic nested brief contract.

Redirect source-reference fields are also machine-constrained separately from authoritative evidence: `conflictingSourceRefs`, forbidden-beat `sourceRefs`, and pressure `sourceEvidenceRefs` may cite only source-draft/source-negative IDs.

When a provider mixes authorities inside a required Redirect evidence list, semantic validation keeps the request-known refs with the correct authority and drops the stray refs. The field still fails when no valid ref remains, so this normalization removes provider noise without inventing grounding.

Scene-character citations are advisory. If a returned character row has no valid authoritative citation, runtime may recover citations from frozen non-source evidence whose excerpt explicitly names that character. Rows with no such evidence are dropped, and Redirect still fails character coverage when no evidence-backed scene character remains.

The Redirect transform provider contract is flat and mode-specific. It returns only `schema`, `mode`, `sourceHash`, `snapshotHash`, `diagnosisHash`, and top-level `text`. It does not return the shared nested `candidate`, `patches`, `changeLedger`, `cardOutcomes`, `preservationLedger`, or `riskFlags` fields. The provider boundary constructs the private canonical candidate with empty Redirect preservation and risk lists plus one deterministic `redirect` ledger entry grounded in the validated replacement-objective and required-beat evidence. Runtime reconstructs exactly one audit row per frozen installed card with `status: "partially-reflected"` and the matching `card:<id>` evidence reference. Repair and Recompose retain their existing nested pass contract and strict card-outcome coverage. Locally constructed ledger and audit fields do not weaken candidate validation or verification: the complete candidate must still satisfy the validated Redirect diagnosis and pass the independent eight-check verifier before a swipe can be added.

```js
function redirectPressureSchema(validEvidenceIds, validPreservationEvidenceIds) {
  const optionalEvidenceRefs = (values) => ({
    ...editorialEvidenceRefsSchema(values),
    minItems: 0
  });
  const properties = {
    character: { type: 'string' },
    immediateWant: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    wantEvidenceRefs: optionalEvidenceRefs(validPreservationEvidenceIds),
    sourcePressureEffect: { enum: [...REDIRECT_PRESSURE_EFFECTS] },
    sourceEvidenceRefs: optionalEvidenceRefs(validEvidenceIds),
    pressureReason: { type: 'string' }
  };
  const required = [
    'character', 'immediateWant', 'wantEvidenceRefs',
    'sourcePressureEffect', 'sourceEvidenceRefs', 'pressureReason'
  ];
  const variant = (overrides) => ({
    type: 'object',
    properties: { ...properties, ...overrides },
    required,
    additionalProperties: false
  });
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
    anyOf: [
      variant({
        immediateWant: { type: 'null' },
        wantEvidenceRefs: { ...optionalEvidenceRefs(validPreservationEvidenceIds), maxItems: 0 },
        sourcePressureEffect: { const: 'unclear' },
        sourceEvidenceRefs: { ...optionalEvidenceRefs(validEvidenceIds), maxItems: 0 }
      }),
      variant({
        immediateWant: { type: 'string' },
        wantEvidenceRefs: editorialEvidenceRefsSchema(validPreservationEvidenceIds),
        sourcePressureEffect: { enum: [...REDIRECT_PRESSURE_EFFECTS] },
        sourceEvidenceRefs: editorialEvidenceRefsSchema(validEvidenceIds)
      })
    ]
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

The provider-facing output is intentionally minimal:

```js
{
  schema: 'recursion.editorialPass.v1',
  mode: 'redirect',
  sourceHash,
  snapshotHash,
  diagnosisHash,
  text: 'Complete rewritten assistant response.'
}
```

`normalizeRoleResponseEnvelope()` copies the frozen identity values and converts this into the canonical internal `candidate` object. The runtime-owned `redirect` ledger cites the already validated replacement-objective and required-beat evidence. Extra shared-mode and audit fields are discarded rather than allowed to shift or poison the Redirect pass.

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

An active required beat must remain active: passive attention, agreement,
observation, or internal feeling is not an equivalent substitute for required
speech or action. This follows the validated beat, not the advisory pressure map;
pressure alone still never forces visible action.

## Candidate validation

The existing full-candidate checks remain necessary but are not sufficient for Redirect.

Deterministic Redirect validation additionally requires:

- exactly one normalized full candidate and no patches;
- a candidate different from the source;
- candidate text no longer inheriting Recompose's source-relative `1.75x` cap;
  Redirect may expand a short failed source up to the shared absolute
  16,000-character bound;
- a change ledger containing at least one `kind: "redirect"` entry;
- every Redirect ledger entry citing at least one authoritative objective or required-beat evidence reference;
- exact diagnosis hash identity;
- exact preservation ledger identity;
- deterministic installed-card audit coverage constructed from the frozen hand;
- mandatory verifier execution before host mutation.

The Redirect machine schema does not expose `changeLedger`. Runtime constructs
one non-empty `kind: "redirect"` entry from the validated replacement objective
and required-beat evidence. Deterministic validation still requires that
canonical entry and rejects a missing or wrongly grounded ledger. Other modes
retain their provider-authored broader change-kind vocabulary.

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

Redirect verification prefers a healthy Reasoner at every reasoning level, even
when Medium diagnosis and transformation remain on Utility. This keeps the semantic
gate independent from the model that authored the candidate. Utility is used only
when no healthy Reasoner is available.

```js
export function editorialVerificationRequired(mode = '', reasoningLevel = '') {
  if (mode === 'redirect') return true;
  return mode === 'recompose' && ['high', 'ultra'].includes(reasoningLevel);
}

const verificationRequired = editorialVerificationRequired(
  editorialMode,
  settings.reasoningLevel
);

if (verificationRequired) {
  // Existing one-candidate accept/reject verification path.
}
```

The same `verificationRequired` value must be calculated once before cache lookup and used by both `editorialPassKey()` and the execution branch:

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

This prevents Medium Redirect from reusing a `direct` pass produced under the old High/Ultra-only policy. The helper belongs in `src/editorial-transform.mjs` beside `editorialPassKey()` so policy and identity cannot drift apart.

The verifier returns no candidate prose and cannot request another candidate. For
Redirect, `buildEditorialVerificationRequest()` includes the complete validated
diagnosis in the private provider prompt and request object. A diagnosis hash alone
is not sufficient because the verifier must inspect the replacement objective,
required beats, forbidden source beats, and advisory character-pressure map. The
diagnosis remains absent from public runtime/UI projection. The provider evaluates
these checks and returns only the names that fail or remain unclear:

```js
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

const providerVerification = {
  schema: 'recursion.editorialVerification.v1',
  mode: 'redirect',
  sourceHash,
  snapshotHash,
  diagnosisHash,
  candidateHash,
  failedChecks: [],
  reason: 'All required Redirect checks passed.'
};
```

### Verification provider schema

`src/providers.mjs` uses a compact Redirect-only provider contract. Recompose keeps
its direct `decision` contract:

```js
if (schema === EDITORIAL_VERIFICATION_SCHEMA && mode === 'redirect') {
  return {
    name: schemaSafeName(schema),
    schema: {
      type: 'object',
      properties: {
        schema: { const: schema },
        mode: { const: 'redirect' },
        sourceHash: { const: String(request.sourceHash) },
        snapshotHash: { const: String(request.snapshotHash) },
        diagnosisHash: { const: String(request.diagnosisHash) },
        candidateHash: { const: String(request.candidateHash) },
        failedChecks: {
          type: 'array',
          minItems: 0,
          maxItems: REDIRECT_VERIFICATION_CHECKS.length,
          uniqueItems: true,
          items: { enum: [...REDIRECT_VERIFICATION_CHECKS] }
        },
        reason: { type: 'string' }
      },
      required: [
        'schema', 'mode', 'sourceHash', 'snapshotHash',
        'diagnosisHash', 'candidateHash', 'failedChecks', 'reason'
      ],
      additionalProperties: false
    }
  };
}
```

### Verification semantic validation

The provider boundary validates `failedChecks`, derives `decision`, and constructs
all eight canonical rows with frozen evidence references. An empty failed-check list
becomes `accept`; any listed check becomes `reject`. Unknown, duplicate, or malformed
names produce an invalid canonical decision so the normal semantic validator and
single verifier-only correction path remain authoritative.

`validateEditorialVerification()` still receives the canonical internal result and
enforces exact Redirect coverage. A structurally valid `reject` remains a valid
verifier result; runtime then rejects the candidate. An `accept` with any non-pass
check is itself invalid.

```js
function validateRedirectVerificationChecks(checks, known, decision) {
  if (!Array.isArray(checks) || checks.length !== REDIRECT_VERIFICATION_CHECKS.length) {
    return fail('RECURSION_EDITORIAL_REDIRECT_VERIFICATION_CHECKS_INVALID', 'Redirect verification check coverage is incomplete.');
  }
  const byName = new Map();
  for (const entry of checks) {
    if (!REDIRECT_VERIFICATION_CHECKS.includes(entry?.check) || byName.has(entry.check)) {
      return fail('RECURSION_EDITORIAL_REDIRECT_VERIFICATION_CHECKS_INVALID', 'Redirect verification returned an unknown or duplicate check.');
    }
    if (!['pass', 'fail', 'unclear'].includes(entry?.status) || !refs(entry?.evidenceRefs, known)) {
      return fail('RECURSION_EDITORIAL_REDIRECT_VERIFICATION_CHECKS_INVALID', 'Redirect verification returned an invalid status or evidence reference.');
    }
    byName.set(entry.check, entry);
  }
  if (REDIRECT_VERIFICATION_CHECKS.some((check) => !byName.has(check))) {
    return fail('RECURSION_EDITORIAL_REDIRECT_VERIFICATION_CHECKS_INVALID', 'Redirect verification omitted a required check.');
  }
  if (decision === 'accept' && [...byName.values()].some((entry) => entry.status !== 'pass')) {
    return fail('RECURSION_EDITORIAL_REDIRECT_VERIFICATION_ACCEPT_INVALID', 'Redirect verification cannot accept a failed or unclear check.');
  }
  return { ok: true, checks: [...byName.values()] };
}

export function validateEditorialVerification(result = {}, {
  mode = '',
  sourceHash = '',
  snapshotHash = '',
  diagnosisHash = '',
  candidateHash = '',
  evidence = []
} = {}) {
  const data = object(result);
  if (
    data.schema !== EDITORIAL_VERIFICATION_SCHEMA
    || data.mode !== mode
    || data.sourceHash !== sourceHash
    || data.snapshotHash !== snapshotHash
    || data.diagnosisHash !== diagnosisHash
    || data.candidateHash !== candidateHash
  ) {
    return fail('RECURSION_EDITORIAL_VERIFICATION_STALE', 'Editorial verification does not match the candidate.');
  }
  if (!['accept', 'reject'].includes(data.decision)) {
    return fail('RECURSION_EDITORIAL_VERIFICATION_INVALID', 'Editorial verifier must return accept or reject.');
  }
  const known = evidenceMap(evidence);
  if (data.evidenceRefs !== undefined && !refs(data.evidenceRefs, known)) {
    return fail('RECURSION_EDITORIAL_EVIDENCE_INVALID', 'Editorial verification cited unknown evidence.');
  }
  const redirectChecks = mode === 'redirect'
    ? validateRedirectVerificationChecks(data.checks, known, data.decision)
    : { ok: true, checks: [] };
  if (!redirectChecks.ok) return redirectChecks;
  return {
    ok: true,
    decision: data.decision,
    checks: redirectChecks.checks,
    evidenceRefs: array(data.evidenceRefs).map(String),
    reason: safeText(data.reason || '', 600)
  };
}
```

`buildEditorialVerificationRequest()` computes `candidateHash` from the validated candidate text, includes it in the structured request and prompt identity, and runtime passes the same value to `validateEditorialVerification()`. Redirect also receives `diagnosisValidation.value` as private verifier evidence. The persisted marker and model-effectiveness artifact use that exact hash.

An `accept` result is valid only when every required check is present exactly once and has `status: "pass"`. Any `fail`, `unclear`, missing check, unknown evidence reference, or malformed result rejects the candidate and preserves the original.

For `required-beats-satisfied`, the verifier treats a beat as satisfied only when
its supported substance is materially explicit in the candidate. Adjacent context
or passive behavior cannot stand in for a diagnosed active beat.

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

Private handling is a deterministic contract, not only a visual expectation. Runtime and UI tests must capture the next prompt packet, rendered view model, assistant text, swipe metadata, and journal delta after an accepted Redirect:

```js
const privateText = JSON.stringify(marker.redirect.characterPressure);

assertEqual(message.swipe_info[1].extra.recursion.enhancement.redirect.characterPressure.length, 1, 'private pressure audit persists with the Recursion swipe marker');
assert(!message.swipes[1].includes(privateText), 'private pressure audit never enters assistant prose');
assert(!JSON.stringify(nextPromptPacket).includes(privateText), 'private pressure audit never enters the next installed host prompt');
assert(!JSON.stringify(runtime.view()).includes(privateText), 'private pressure audit is absent from the visible runtime view model');
assert(!JSON.stringify(journalDelta).includes(privateText), 'run journal records only Redirect hashes, counts, and status');
```

`tools/scripts/test-provider-response-parser.mjs` must also prove that a provider-returned diagnosis containing nested `characterPressure` survives structured-response extraction unchanged. The normalizer may serialize the whole structured object; it must not flatten or omit the nested Redirect fields.

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

Redirect-specific semantic failures use stable codes so provider failures, status text, journal entries, and tests refer to the same condition:

```js
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

User-visible settlement is intentionally compact:

| Failure boundary | Activity/status text | Terminal state |
| --- | --- | --- |
| Diagnosis schema, evidence, character coverage, or pressure | `Redirect diagnosis failed. Original kept.` | `failed` |
| Candidate lacks an evidence-backed directional change | `Redirect candidate failed. Original kept.` | `failed` |
| Verifier malformed, incomplete, unclear, or rejecting | `Redirect verification failed. Original kept.` | `failed` |
| Host swipe commit fails | `Redirect could not add the new swipe. Original kept.` | `failed` |

None of these paths may settle as caution followed by success, retain a green Redirect candidate row, or emit `editorial.run.settled` with `status: "success"`.

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

### 1. Provider machine schemas and response normalization

Extend `tools/scripts/test-providers.mjs` with separate Redirect and Recompose requests. These tests assert the full nested machine schema rather than checking only prompt text:

```js
const redirectDiagnosisSchema = machineJsonSchemaForRequest({
  responseSchema: EDITORIAL_DIAGNOSIS_SCHEMA,
  machineJson: true,
  mode: 'redirect',
  sourceHash,
  snapshotHash,
  validEvidenceIds: ['user:0', 'card:active-cast', 'source:0'],
  validPreservationEvidenceIds: ['user:0', 'card:active-cast']
});

assertDeepEqual(
  redirectDiagnosisSchema.schema.properties.brief.required,
  [
    'mode', 'diagnosis', 'preserve', 'discard', 'allowedChanges', 'forbiddenChanges',
    'sourceFailure', 'replacementObjective', 'requiredBeats', 'forbiddenSourceBeats',
    'sceneCharacters', 'characterPressure'
  ],
  'Redirect diagnosis schema requires the complete turn-level contract'
);

assert(
  !machineJsonSchemaForRequest({ ...redirectRequest, mode: 'recompose' })
    .schema.properties.brief.required.includes('characterPressure'),
  'Recompose machine schema remains free of Redirect-only fields'
);
```

Provider tests must additionally prove:

- `sourceFailure` and `replacementObjective` permit `null` for `no-change`;
- preservation, objective, required-beat, presence, and want evidence enums exclude `source:N`;
- conflicting and pressure source fields can cite `source:N` and are semantically source-only;
- Redirect verification requires exactly the eight named checks;
- Recompose verification does not require Redirect checks;
- verifier source, snapshot, diagnosis, mode, and candidate hash fields are frozen from the request;
- `additionalProperties: false` prevents a model-authored alternate contract;
- `test-provider-response-parser.mjs` round-trips nested pressure data without flattening or loss.

### 2. Diagnosis schema and semantic validation

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
- `sceneCharacters` omits a character clearly named by frozen Active Cast evidence; the mandatory verifier must fail `character-pressure-coherent` and runtime must add no swipe.

Recompose fixtures must continue to validate without Redirect-only fields.

### 3. Candidate distinction

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

### 4. Pressure remains advisory

Add fixtures proving:

- increasing pressure can support a stronger spoken response;
- increasing pressure can support deliberate silence or restraint;
- decreasing pressure can produce relief or recalibration;
- unchanged pressure does not force a character beat;
- unclear pressure does not invent motivation;
- not every present character needs dialogue or action.

The acceptance condition is coherence with evidence, not maximum visible reaction.

### 5. Runtime verification, identity, and settlement policy

Extend `tools/scripts/test-editorial-runtime.mjs`:

```js
await runtime.updateSettings({ enhancements: { mode: 'redirect', applyMode: 'as-swipe' }, reasoningLevel: 'medium' });
await runtime.enhanceLatestAssistantMessage();

assertEqual(verifierCalls.length, 1, 'Redirect always verifies at Medium');
assertEqual(message.swipes.length, 2, 'accepted Redirect appends exactly one swipe');
assertEqual(message.swipeId, 1, 'accepted Redirect selects the appended swipe');
```

Also prove:

- `editorialVerificationRequired('redirect', level)` is true for `low`, `medium`, `high`, and `ultra`;
- the same helper result is embedded in `editorialPassKey()` before cache lookup;
- Medium Redirect cannot reuse a previous `direct` cache entry;
- repeated identical verified Redirect requests reuse only an accepted `verify` entry and do not call the provider again;
- host cached-swipe lookup returns the persisted marker with the selected index/text, and runtime reuses that marker rather than reconstructing an incomplete marker from the lookup key;
- a rejected Redirect verifier leaves one original swipe;
- a malformed verifier result leaves one original swipe;
- a verifier `accept` containing any `fail` or `unclear` check is rejected as invalid;
- unknown, duplicate, missing, and bad-evidence verifier checks fail independently;
- a verifier response carrying a different candidate hash fails as stale;
- success is not visible before host append settlement;
- Recompose at Medium does not gain mandatory verification;
- Redirect never honors a requested Replace apply mode.
- a source swipe change while verification is pending prevents commit;
- each Redirect error code settles the progress tree as failed, records no successful editorial settlement, and adds no swipe;
- a `no-change` diagnosis makes no transformer or verifier call.

### 6. Model-effectiveness corpus and executable judge

The existing harness accepts only `smoke`, `core`, and `stress` pack names, while the repository currently contains only the `smoke/` scenario directory. Create `tests/evaluation/scenarios/core/` and add fixed Redirect scenarios there with tags `editorial` and `redirect`; do not create an unloaded `editorial/` directory:

- `redirect-turn-deferral.json`: the OV-1 test-now versus postpone failure;
- `redirect-wrong-focus.json`: source answers atmosphere instead of the user's action;
- `redirect-unsupported-outcome.json`: source resolves an outcome the user did not establish;
- `redirect-character-pressure.json`: rising pressure supports a stronger response;
- `redirect-supported-restraint.json`: rising pressure is answered through supported silence/restraint;
- `redirect-insufficient-want-evidence.json`: no-change rather than invented motivation.

The judge must evaluate trajectory and evidence, not lexical distance. The same minor rewrite may be a possible Recompose but must fail the Redirect objective.

Extend `normalizeScenario()` with an optional `oracle.editorialRedirect` object:

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

`tools/scripts/lib/model-eval-harness.mjs` currently emits `model-effectiveness-not-implemented`. Redirect cannot claim corpus success until tagged scenarios execute the existing `output` judge and produce a non-skipped verdict:

```js
const redirectScenarios = scenarios.filter((scenario) =>
  scenario.tags.includes('editorial') && scenario.tags.includes('redirect')
);
const redirectEffectiveness = await editorialEffectivenessRunner({
  scenarios: redirectScenarios,
  task: 'output',
  judgeModel: args.judgeModel,
  strict: args.strict
});
report.modelEffectiveness.redirect = redirectEffectiveness;
if (redirectEffectiveness.status !== 'pass') {
  reportStatus(report, 'fail', redirectEffectiveness.result || 'redirect-model-effectiveness-failed');
}
```

The harness entry point takes an injected runner for deterministic tests and a real default runner for strict/live execution:

```js
export async function runModelEval({
  argv = [],
  env = process.env,
  artifactRoot = null,
  liveSmokeRunner = defaultLiveSmokeRunner,
  editorialEffectivenessRunner = defaultEditorialEffectivenessRunner
} = {}) {
  // Existing argument, budget, scenario, traversal, redaction, and report logic.
}
```

`defaultEditorialEffectivenessRunner` must, for each tagged scenario:

1. seed prior context and the scenario user turn into a dedicated
   `recursion-soak-*` chat through the existing Playwright harness;
2. run the real generation-time Recursion pipeline and freeze its Prompt Packet
   before the flawed assistant source lands;
3. land the flawed source response, select Redirect, and execute the real
   configured diagnosis, transformer, and mandatory verifier calls;
4. capture the resulting candidate, marker, journal delta, and strict progress
   oracle;
5. call the configured independent `judgeModel` with the frozen scenario oracle
   and produced candidate;
6. return a structured result without mutating `default-user`.

The harness must never include the flawed source response in
`prepareForGeneration()`. Doing so generates source-derived cards that canonize
the failure Redirect is meant to replace and invalidates the proof.

The live path uses one internal, non-UI provider role named `editorialEffectivenessJudge` with schema `recursion.redirectEffectivenessJudge.v1`. `src/editorial-transform.mjs` owns its request builder and validator; `src/providers.mjs` owns its machine schema/role registration; `src/runtime.mjs` exposes the narrow `evaluateRedirectEffectiveness()` method used by the dedicated live harness. It is not invoked by normal chat generation and does not add a user-facing feature.

The independent output judge is not the production Redirect verifier replayed as a test. Its prompt receives the scenario's expected objective, required and forbidden beats, pressure expectations, frozen evidence, source, and candidate, then returns:

```js
{
  scenarioId: 'redirect-turn-deferral',
  sourceHash,
  candidateHash,
  decision: 'pass',
  criteria: [
    { criterion: 'replacement-objective', status: 'pass', reason: 'The test begins in the replacement turn.' },
    { criterion: 'forbidden-source-beats', status: 'pass', reason: 'The parking-lot deferral is absent.' },
    { criterion: 'character-pressure', status: 'pass', reason: 'Rising pressure informs Carter without forcing every character to act.' },
    { criterion: 'evidence-and-constraints', status: 'pass', reason: 'No unsupported fact or motivation was introduced.' }
  ],
  providerId: 'configured-judge-provider',
  model: 'configured-judge-model'
}
```

All four criteria are required exactly once. `decision: "pass"` requires all four to pass. This judge contract is implemented and machine-schema tested alongside the harness; it is not inferred from edit distance, slop reduction, progress color, or the production marker's self-reported card outcomes.

The result artifact must retain, per scenario, the candidate hash, decision, eight verifier checks, failed criteria, provider/model identity, and pass/fail status. `skipped`, missing judge output, or an empty Redirect scenario set is a failure in strict mode. `tools/scripts/test-model-eval-harness.mjs` must inject a deterministic `editorialEffectivenessRunner` and prove pass, semantic fail, skipped, malformed, empty-corpus, and fail-fast behavior before the live runner is trusted.

### 7. Live Playwright proof

The dedicated live Enhancement proof should use a `recursion-soak-*` account and a fixed user turn whose source visibly defers a required action. A successful Redirect requires:

- healthy diagnosis, candidate, verification, and prompt-ready progress;
- no historical caution, warning, failure, or skipped success state;
- one new Recursion-owned swipe;
- a marker with `mode: "redirect"`, `verification: "accept"`, and at least one `redirect` ledger entry;
- private Redirect metadata present but absent from visible UI and final prose;
- semantic judge acceptance that the replacement objective was fulfilled and the forbidden source beat was removed.

The script exit code must derive from the strict live-enhancement oracle plus the Redirect semantic judge. A green progress tree alone is not proof of a successful Redirect.

### 8. Private-data boundary tests

Deterministic privacy assertions run before Playwright:

- `test-editorial-runtime.mjs` proves private Redirect metadata persists only on the Recursion-owned swipe marker and never enters the next prompt packet or assistant text.
- `test-ui.mjs` and `test-runtime.mjs` prove `characterPressure`, immediate wants, and pressure reasons do not enter the visible view model, inspector, Last Brief, tooltips, or status text.
- `test-provider-response-parser.mjs` proves nested diagnosis fields survive provider normalization intact.
- journal assertions prove only diagnosis/candidate hashes, character count, verification status, and error code are recorded.
- a literal unique sentinel inside a pressure reason is used for absence assertions so tests cannot pass by checking only field names.

```js
const privateSentinel = 'PRIVATE_REDIRECT_PRESSURE_SENTINEL';
assert(!message.swipes[1].includes(privateSentinel), 'private pressure sentinel is absent from prose');
assert(!JSON.stringify(nextPromptPacket).includes(privateSentinel), 'private pressure sentinel is absent from the next prompt');
assert(!JSON.stringify(runtime.view()).includes(privateSentinel), 'private pressure sentinel is absent from the visible view model');
assert(!JSON.stringify(journalDelta).includes(privateSentinel), 'private pressure sentinel is absent from journal details');
assert(JSON.stringify(message.swipe_info[1]).includes(privateSentinel), 'private pressure sentinel remains in Recursion-owned swipe metadata');
```

## Verification sequence

Implementation follows red-green TDD. Run focused gates first, then the broad and live gates:

```powershell
npm.cmd run test:providers
node tools/scripts/test-provider-response-parser.mjs
node tools/scripts/test-editorial-transform.mjs
node tools/scripts/test-editorial-runtime.mjs
npm.cmd run test:runtime
npm.cmd run test:ui
npm.cmd run test:model-eval
npm.cmd test
npm.cmd run prove:enhancements-live
```

The first run of each new focused regression must fail for the missing Redirect behavior before production code is changed. `prove:enhancements-live` runs only against a configured `recursion-soak-*` account with real model calls; it is not replaced by mocked browser state.

## Integration map

Implementation should update these existing boundaries in place:

| File | Responsibility |
| --- | --- |
| `src/providers.mjs` | Redirect-only diagnosis/verification schemas plus the internal effectiveness-judge role and schema |
| `src/providers/provider-response-normalizer.mjs` | Preserve nested Redirect diagnosis objects; change only if the new parser regression exposes loss |
| `src/editorial-transform.mjs` | Shared Redirect constants and verification policy, brief/pressure validation, prompt rules, candidate ledger validation, exact verifier-check validation, effectiveness-judge request/validation |
| `src/runtime.mjs` | Use shared verification policy for cache identity and execution, persist/reuse private marker metadata, enforce terminal settlement, expose the narrow live-harness effectiveness judge method |
| `src/hosts/sillytavern/host.mjs` | Return the persisted enhancement marker from cached-swipe lookup so verified Redirect identity survives reuse |
| `src/ui.mjs` and `src/ui/view-model.mjs` | Remain unaware of private pressure content; change only if deterministic privacy tests expose a leak |
| `tools/scripts/test-providers.mjs` | Complete Redirect diagnosis/verifier machine schemas and Recompose non-regression |
| `tools/scripts/test-provider-response-parser.mjs` | Nested Redirect structured-response round trip |
| `tools/scripts/test-editorial-transform.mjs` | Diagnosis, evidence authority, character coverage, and candidate negative controls |
| `tools/scripts/test-editorial-runtime.mjs` | Verification/cache policy, private marker and next-prompt boundaries, host mutation behavior, terminal status |
| `tools/scripts/test-host.mjs` | Cached-swipe lookup returns the exact persisted Redirect marker with index/text |
| `tools/scripts/test-ui.mjs` and `tools/scripts/test-runtime.mjs` | Private-data absence from visible state and status surfaces |
| `tools/scripts/lib/model-eval-harness.mjs` | Execute tagged Redirect output-judge scenarios; strict mode rejects skipped or empty effectiveness evidence |
| Create `tools/scripts/lib/live-editorial-effectiveness.mjs` | Reusable dedicated-user Playwright runner for scenario seeding, real Redirect execution, and independent output judging |
| `tools/scripts/test-model-eval-harness.mjs` | Deterministic pass/fail/skipped/malformed/empty-corpus harness controls |
| `tools/scripts/prove-live-enhancements.mjs` | Mode-specific Redirect semantic acceptance |
| Create `tests/evaluation/scenarios/core/redirect-*.json` | Fixed Redirect and pressure scenarios loaded through the harness's supported `core` pack |
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
5. One shared policy makes Redirect verification mandatory in both cache identity and runtime execution at all reasoning levels.
6. Redirect verification cannot accept a missing, duplicate, failed, unclear, or bad-evidence required check.
7. The OV-1 condensation candidate fails Redirect and creates no swipe.
8. A valid materially redirected candidate creates and selects exactly one swipe.
9. Reusing a verified Redirect selects the existing swipe and returns its persisted accepted marker without provider calls.
10. Private pressure metadata never appears in visible UI, final prose, Last Brief, the next host prompt, or journal details.
11. The core-pack Redirect effectiveness corpus executes a real output judge; skipped or empty judge evidence fails strict mode.
12. Focused tests, `npm.cmd test`, the model-effectiveness Redirect corpus, and the dedicated live Playwright proof pass.
13. The served or installed SillyTavern extension copy is hash-checked before any live success claim.
