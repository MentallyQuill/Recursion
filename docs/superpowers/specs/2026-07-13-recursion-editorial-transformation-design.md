# Recursion Editorial Transformation Design

## Status

**Implemented baseline.** This document supersedes the
patch-only product boundary in [Generation Review and Enhancement
Design](2026-07-12-recursion-generation-review-and-enhancement-design.md) and
the bounded-write limitation in the [Generation Review and Enhancement
Contract](../../architecture/ENHANCEMENT_REVIEW_AND_PATCH_CONTRACT.md).

The diagnosis, candidate, verification, persistence, privacy, and test contracts for
`Redirect` are superseded by the implemented
[Redirect Improvement Design](2026-07-15-recursion-redirect-improvement-design.md).
The `Repair` and `Recompose` contracts in this document remain authoritative.

Recursion will no longer treat a material editorial improvement as inherently
unsafe merely because it cannot be expressed as a handful of source patches.
It will retain its frozen generation evidence, provenance, deterministic
validation, and user-visible application semantics while allowing a complete,
confident replacement draft when that draft is justified by the evidence.

There is deliberately **no tournament**, multi-candidate ranking, or invisible
selection among alternate drafts. Each operation produces one candidate. The
user retains control through the original message and the default `As Swipe`
application mode.

## Product decision

The compact bar continues to expose one **Enhancement** control. Its selection
is now an editorial mode rather than a boolean:

| Mode | Job | Writable artifact | Source relationship |
| --- | --- | --- | --- |
| `Off` | Do nothing after generation. | None. | None. |
| `Repair` | Correct localized, evidence-backed defects. | Deterministic patches. | Preserve the draft except for the repairs. |
| `Recompose` | Deliver a stronger complete version of the same response turn. | One complete response candidate. | Preserve the supported turn intent, facts, commitments, and scene state; freely rewrite language, staging, sequencing, pacing, and dialogue. |
| `Redirect` | Write the response the turn should have received when the source is fundamentally pointed the wrong way. | One complete response candidate. | Use the source as negative evidence; preserve only facts, commitments, and constraints that the frozen evidence supports. |

`Repair`, `Recompose`, and `Redirect` are not a quality ladder that runs in
sequence. The selected mode is the only editorial operation for the completed
assistant message. Recursion never runs Repair first and then silently turns a
repair into a Recompose, and it never generates several Recomposes to choose a
winner.

```text
Frozen turn evidence + completed assistant response
                         |
              selected editorial mode
                         |
      Repair: validated source patches
   Recompose: one evidence-led full candidate
    Redirect: one evidence-led replacement turn
                         |
              As Swipe by default / Replace when allowed
```

The decisive contract change is this:

> The original draft is evidence, not an untouchable structure. Preserve what
> the frozen turn establishes; change or discard what fails the editorial
> brief.

## Why the modes are separate

### Repair

Repair is the current Generation Review philosophy, narrowed to where it is
strongest: a mistaken line, repetitive gesture, weak exchange, local card
fidelity omission, or bounded pacing/staging problem. Its exact source ranges
make it cheap, explainable, and safe to apply as `Replace` when the user wants
that behavior.

Repair is not a timid Recompose. If the reviewer concludes that the response
needs new scene movement, a rewritten conversational rhythm, reordered beats,
or a different opening, it must return `requires-recompose` or
`requires-redirect`, never try to fake broad improvement through many small
patches.

### Recompose

Recompose is the main new editorial capability. It writes one alternate draft
of the same response turn. It may:

- replace every sentence;
- move or combine locally supported beats;
- rewrite dialogue, narration, staging, and paragraph structure together;
- remove weak or redundant material rather than preserving it for diff size;
- make an installed card's relevant pressure or voice visible when the scene
  evidence supports that move.

It may not change established facts, resolve an unresolved user choice, invent
a consequential event, contradict installed constraints, or turn an
unexpressed card into a forced visible checklist item.

The target is not superficial variance. A Recompose should have a clear
editorial thesis: for example, *replace generic intimacy with visible physical
distance and interrupted dialogue*, or *move the threat into the opening and
make the reply answer the user's actual action before atmosphere arrives*.

### Redirect

Redirect is intentionally stronger than Recompose. It says the source failed
at the turn level: it dodged the user, chose the wrong dramatic focus, ignored
an essential constraint, manufactured an unsupported outcome, or continued a
scene that the current evidence no longer supports. The model treats weak or
wrong source prose as negative evidence rather than material to preserve.

Redirect still has a hard floor: it preserves the user-visible situation and
any fact, commitment, safety boundary, card instruction, or story-form
constraint established by the frozen snapshot. It cannot rewrite history. It
can rewrite the response turn that history should have produced.

Redirect is always inserted as a swipe. It never silently overwrites the live
assistant message. That makes its scope legible and leaves the player an easy
way to compare or return to the original response.

## Evidence-led editorial brief

Every non-Off operation is built from one immutable snapshot captured after
the host assistant message lands. It retains the existing generation-time
sources: source message and hash, latest user turn, bounded chat context,
installed-card manifest and lineage, Prompt Packet, Last Brief, story form,
and anti-slop profile.

The model receives an explicit brief before it is allowed to write. The brief
is produced and validated in a separate **diagnosis** call; it is not a
self-authored explanation bundled with the candidate. That separation prevents
a full rewrite from becoming unconstrained taste:

```ts
type EvidenceRef = {
  id: string;
  kind: 'source' | 'user-turn' | 'context' | 'prompt-packet' | 'last-brief' | 'installed-card' | 'story-form';
  excerpt: string;
};

type EditorialBrief = {
  mode: 'repair' | 'recompose' | 'redirect';
  diagnosis: Array<{
    dimension: 'turn-fulfillment' | 'card-fidelity' | 'scene-execution' | 'voice' | 'pacing' | 'anti-slop';
    problem: string;
    evidenceRefs: string[];
  }>;
  preserve: Array<{ claim: string; evidenceRefs: string[] }>;
  discard: Array<{ claim: string; evidenceRefs: string[] }>;
  allowedChanges: string[];
  forbiddenChanges: string[];
};
```

### Evidence authority

The runtime creates the evidence reference IDs and assigns each one an
authority class. The provider can cite only those IDs; it never makes up a
card, source passage, or implied story fact.

| Authority | Sources | Editorial rule |
| --- | --- | --- |
| `hard-constraint` | Explicit user request, story-form prohibition, installed instruction-shaped card, safety boundary. | Must not be contradicted, resolved, or silently dropped. |
| `continuity-fact` | Latest user turn, bounded prior transcript, Last Brief, explicitly structured Prompt Packet state. | Preserve unless a higher-priority hard constraint says otherwise. |
| `scene-support` | Installed card guidance, character evidence, scene frame, relevant packet detail. | May justify a concrete rewrite move; does not force literal mention. |
| `source-draft` | The completed assistant response. | Editable prose; never enough by itself to establish a fact for Recompose or Redirect. |
| `source-negative` | A diagnosed unsupported, evasive, repetitive, or contradictory source passage. | May justify removal, replacement, or Redirect; never supports a preservation claim. |

The source text remains available in both prompts, but it is not automatically
preservation evidence. A preservation claim must cite a `hard-constraint`,
`continuity-fact`, or applicable `scene-support` item. In particular, Redirect
cannot turn a flawed source assertion into canon merely by citing it.

The initial snapshot exposes source passages only as `source-draft`.
Diagnosis may cite those passages for a `discard` finding; after that finding
passes validation, the runtime includes its referenced source IDs in the
accepted brief as derived `source-negative` evidence for Transform. Neither
class is valid for a preservation claim.

### Bounded evidence and persisted explanation

Evidence is deliberately finite and safe to persist:

- at most 120 evidence entries, each with a 600-character excerpt and a
  12,000-character total excerpt budget;
- diagnosis: at most 10 findings, 12 preserve claims, 12 discard claims, 12
  allowed/forbidden changes, and 280 visible characters per claim;
- candidate: at most 12 preservation entries and 12 change entries, each with
  at most 280 visible characters and 8 cited evidence IDs;
- candidate text: non-empty and different after normalized whitespace;
  Recompose is no more than
  `min(16000, max(1500, ceil(sourceLength * 1.75)))` characters, while Redirect
  may rebuild a short failed turn up to the absolute 16,000-character bound.

These are output/persistence caps, not an edit-ratio rule. Recompose and
Redirect may replace every source sentence; they may not become an uncontrolled
verbosity expansion or persist unbounded provider data.

## Editorial pipeline and outcome state machine

Each enabled invocation has one immutable evidence snapshot and proceeds in
this order:

```text
capture snapshot
  -> diagnose and validate editorial brief
  -> one transform request using that validated brief
  -> deterministic candidate validation
  -> High/Ultra binary verification (full candidates only)
  -> apply or reveal original
```

The diagnosis produces a distinct machine artifact:

```ts
type EditorialDiagnosis = {
  schema: 'recursion.editorialDiagnosis.v1';
  mode: 'repair' | 'recompose' | 'redirect';
  sourceHash: string;
  snapshotHash: string;
  decision: 'proceed' | 'no-change' | 'requires-recompose' | 'requires-redirect';
  brief: EditorialBrief;
};
```

After validation, Recursion derives `diagnosisHash` from the canonical public
diagnosis. The provider never chooses that identity. The transform request and
its response must echo the runtime-derived hash exactly.

Its decision has exact behavior:

| Selected mode | Valid diagnosis decision | Runtime behavior |
| --- | --- | --- |
| `Repair` | `proceed`, `no-change`, `requires-recompose`, `requires-redirect` | Only `proceed` invokes the transformer. Escalation is shown as an available next action; it is never run automatically. |
| `Recompose` | `proceed`, `no-change`, `requires-redirect` | Only `proceed` invokes the transformer. `requires-redirect` keeps the original and tells the user why a stronger turn-level correction is needed. |
| `Redirect` | `proceed` | An explicit Redirect must identify an evidence-supported turn-level replacement. Invalid or insufficient diagnosis fails visibly after one correction attempt; it never reports skipped success. |

`requires-recompose` and `requires-redirect` are operation outcomes, not card
outcomes and not aliases for host regeneration. They have stable marker,
progress, journal, and UI states. They do not modify the assistant message.

## Machine output contract

The patch-only `recursion.generationReview.v1` contract is replaced in place by
the diagnosis schema above plus `recursion.editorialPass.v1`. The transformer
receives the validated brief and its hash, then emits the writable artifact.
Pre-alpha Recursion does not normalize obsolete `prose`, `dialogue`, `on`, or
legacy generation review payloads.

```ts
type EditorialPass = {
  schema: 'recursion.editorialPass.v1';
  mode: 'repair' | 'recompose' | 'redirect';
  sourceHash: string;
  snapshotHash: string;
  diagnosisHash: string;
  cardOutcomes: Array<{
    cardId: string;
    status: 'honored' | 'repaired' | 'not-applicable' | 'partially-reflected' | 'violated';
    evidenceRefs: string[];
  }>;
  patches?: Array<{
    id: string;
    before: string;
    after: string;
    domain: 'dialogue' | 'narrative-execution' | 'anti-slop' | 'card-fidelity';
    evidenceRefs: string[];
  }>;
  candidate?: {
    text: string;
    preservationLedger: Array<{ claim: string; evidenceRefs: string[] }>;
    changeLedger: Array<{
      kind: 'remove' | 'rewrite' | 'reorder' | 'add-supported-detail' | 'redirect';
      summary: string;
      evidenceRefs: string[];
    }>;
    riskFlags: Array<'none' | 'continuity-risk' | 'voice-risk' | 'card-interpretation-risk'>;
  };
};
```

Artifact rules are strict:

- `Repair` must contain one or more patches and must not contain `candidate`.
- `Recompose` and `Redirect` must contain a non-empty `candidate` and no
  patches.
- A candidate must differ materially from the source after normalized
  whitespace. Recompose has no maximum edit ratio; total rewrite is valid.
- `brief`, `preservationLedger`, `changeLedger`, card outcomes, and every
  risk-bearing claim must cite known evidence IDs.
- A card ID must be installed in the frozen hand. Every installed card receives
  exactly one outcome, but `not-applicable` remains valid.
- Any source or snapshot hash mismatch, unknown evidence ID, unknown card,
  empty candidate, duplicate card outcome, or incompatible artifact fails the
  whole provider result. Recursion never applies a partly trustworthy full
  rewrite.
- A candidate whose `diagnosisHash` does not exactly match the accepted
  diagnosis is stale and fails. A writer cannot replace the independently
  approved editorial brief with a new rationale.

`changeLedger` is a compact explanation, not a requirement to enumerate every
word-level difference. It should name the major editorial moves that explain
why this candidate differs. A valid Recompose may report that it rewrote the
opening, collapsed redundant staging, and rebuilt a dialogue exchange; that is
enough to make a dramatic diff intelligible.

## Request contract

The new prompt makes editorial authority explicit while pinning it to frozen
evidence:

```js
export function buildEditorialPassRequest({
  mode,
  sourceText,
  sourceHash,
  snapshotHash,
  diagnosis,
  evidence,
  snapshot,
  lane,
  reasoningCategory,
  reasoningIntent
} = {}) {
  const fullCandidate = mode === 'recompose' || mode === 'redirect';
  const artifactInstruction = fullCandidate
    ? 'Return one complete replacement candidate. You may rewrite every sentence.'
    : 'Return only bounded patches for the supplied source targets.';
  const sourceRule = mode === 'redirect'
    ? 'Treat the source as negative evidence where it fails the brief; preserve only facts supported by frozen evidence.'
    : 'Preserve supported facts, commitments, constraints, and the user turn while improving the response.';

  return {
    responseSchema: EDITORIAL_PASS_SCHEMA,
    machineJson: true,
    lane,
    reasoningCategory,
    reasoningIntent,
    prompt: [
      'Return exactly one Recursion Editorial Pass JSON object.',
      `Selected mode: ${mode}.`,
      artifactInstruction,
      sourceRule,
      'Do not invent a fact, resolve an open player choice, or force an irrelevant installed card into the prose.',
      'The diagnosis below is authoritative. Do not add a new diagnosis or revise its preservation/discard decisions.',
      'Every preservation claim, major change, and card outcome must cite only supplied evidence IDs.',
      `<source_hash>${sourceHash}</source_hash>`,
      `<snapshot_hash>${snapshotHash}</snapshot_hash>`,
      `<diagnosis>${JSON.stringify(diagnosis)}</diagnosis>`,
      `<evidence>${JSON.stringify(evidence)}</evidence>`,
      `<snapshot>${JSON.stringify(snapshot)}</snapshot>`,
      `<source>${sourceText}</source>`
    ].join('\n')
  };
}
```

## Validation and confidence

The safety boundary moves from *small diff* to *valid editorial contract*.
Every candidate passes these gates before it becomes a SillyTavern message:

1. **Identity:** schema, selected mode, source hash, and snapshot hash match
   the immutable run.
2. **Diagnosis identity:** the diagnosis is valid for the selected mode and
   candidate `diagnosisHash` exactly matches it.
3. **Artifact shape:** Repair contains only valid non-overlapping source
   patches; Recompose/Redirect contain one non-empty materially different
   candidate.
4. **Evidence closure:** every reference resolves to an allowed immutable
   evidence item; all installed cards are accounted for.
5. **Claim floor:** preservation claims must cite continuity, scene-support, or
   hard-constraint evidence; source-draft and source-negative citations cannot
   protect a fact.
6. **Hard constraints:** candidate text must not contain a detected
   contradiction with explicit story-form, Prompt Packet, or installed-card
   constraints. Deterministic checks enforce known hard prohibitions; the
   provider remains responsible for open-ended prose judgment.
7. **Bounded result:** all text, ledger, excerpt, and reference limits hold.
8. **Meaningful result:** candidate cannot equal source, and Repair cannot
   result in no applied patch.

At High and Ultra reasoning levels, Recompose receives an **editorial
verification** call after deterministic validation. Redirect is verified at
every reasoning level. The Verifier is not a writer and never supplies an
alternate candidate. It can only return `accept` or `reject` against frozen
evidence. The first valid Redirect rejection may trigger the one remaining
writer attempt and a mandatory second verification; a second rejection reveals
the original and records the reason.

The whole editorial operation has **one shared malformed-output correction
token** for malformed diagnosis or verification output. Transform has a
separate operation-wide budget of at most two actual writer calls. A provider
or schema failure and a verifier-directed correction compete for that same
second writer slot, so no Redirect can make a third writer call. This yields
exactly three normal Redirect calls and at most five calls when the first
candidate is rejected and its corrected replacement is verified.

Provider lane selection follows the existing enhancement policy. When a
Reasoner role fails before the shared recovery token is spent, Recursion may
make one same-role Utility fallback; that fallback does not create another
candidate, diagnosis, or correction token.

Repair and non-verified Recompose retain their existing deterministic mechanical
application checks. Redirect always uses the model Verifier as its semantic
confidence mechanism at every reasoning level. A disabled or failed Reasoner
follows the existing lane fallback rules; the result is marked with the actual
lane and verification state.

## Application, cache, and observability

`As Swipe` remains the default for all enabled modes. It preserves the source
and gives the player a first-class comparison path. `Replace` stays available
for Repair and Recompose only; choosing it is an explicit preference, not a
fallback after a successful candidate. Redirect is locked to `As Swipe`.

Each cached result includes the selected editorial mode, application mode,
source hash, snapshot hash, diagnosis hash, evidence profile version,
producer/verifier provenance, verification state, and the validated artifact.
A Recompose never reuses a Repair result, and changes to prompt packet,
installed hand, story form, bounded context, or anti-slop profile invalidate
reuse.

The persisted swipe marker is `recursion.editorialMarker.v1`. It contains only
compact identity and outcome data: mode, application mode, source/snapshot/
diagnosis/candidate hashes, cache key, outcome, producer/verifier lanes,
verification decision, bounded card outcomes, and capped ledgers/risk flags.
It never persists raw provider output, prompts, evidence excerpts, source text,
or hidden reasoning. The resulting candidate lives only in the normal swipe
text, not duplicated in marker metadata.

The marker and progress tree expose the real operation:

```text
Recomposing response...                    running
  Captured frozen evidence                 done
  Editorial brief                          done
  Recompose candidate                      done
  Evidence and constraint validation       done
  Editorial verification                   accepted
  Enhanced swipe                           added
```

For a Redirect, the visible label is `Redirect candidate`, and its details say
that the source was replaced as a turn-level correction. For Repair, the
existing patch counts remain useful. The viewer shows the source and result
side by side in the existing compact inspector, a concise
preservation/change ledger, card outcomes, risk flags, and whether High/Ultra
verification accepted the candidate. For a large rewrite it labels the result
as a `full response transformation` and shows the ledger first; it does not
pretend to make a huge word diff easy to read by highlighting every token.

The compact selector remains SillyTavern-native and operational:

```text
[Enhancement icon]
  Apply: [As Swipe] [Replace]
  Off
  Repair       Correct local, evidence-backed defects.
  Recompose    Rewrite this response into a stronger supported draft.
  Redirect     Create a swipe for the response this turn needed.
```

When Redirect is selected, `Replace` is disabled with the compact helper text
`Redirect always creates a swipe.` No new dashboard, acceptance workflow, or
candidate carousel is introduced.

## Non-goals

- No tournament, ranking model, score-based automatic selection, or multiple
  visible candidates.
- No rewrite of user turns, card decks, prompts, persistent lore, or prior
  messages.
- No implicit regeneration of the host model after an editorial failure.
- No claim that an installed card must appear literally in the candidate.
- No arbitrary style preset system in this feature; current character, card,
  story-form, and scene evidence remain the voice authority.
- No silent Redirect replacement.

## Acceptance criteria

- The visible setting persists only `off`, `repair`, `recompose`, or
  `redirect`; old target aliases never appear in new UI/provider requests. A
  narrow host-read bridge may recognize an old persisted target only to keep an
  already-running host hook alive during migration.
- Repair accepts only deterministic bounded patches and directs material cases
  to Recompose or Redirect.
- Recompose and Redirect can replace the entire assistant response when their
  evidence ledger validates.
- A full rewrite is rejected if it lacks known evidence references, violates
  an explicit frozen constraint, or is stale/empty/unchanged.
- Redirect always appends and selects a swipe; Recompose defaults to the same.
- High/Ultra verification evaluates one produced candidate only and cannot
  create a second candidate or retry a rejected one.
- Diagnosis is independently validated before the one candidate request; every
  accepted candidate binds to that diagnosis hash.
- A fixed editorial evaluation corpus proves that valid Recomposes are
  materially stronger and that Redirects answer the user without inventing or
  resolving unsupported state.
- A dedicated-user Playwright UI certification runs Off, Repair, Recompose, and
  Redirect across Standard, Rapid, and Fused at desktop and compact-phone
  viewports (24 rows). Every successful fixture must finish with no browser/page errors,
  console warnings, Recursion caution/error indicators, or failed progress
  rows, and must match an approved visual baseline after dynamic regions are
  masked.
- Progress, marker, cache, diagnostics, UI copy, schemas, tests, and user
  docs identify the actual mode and application result.
