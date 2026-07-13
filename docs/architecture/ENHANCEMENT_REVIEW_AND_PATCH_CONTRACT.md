# Generation Review and Enhancement Contract

## Status and intent

**Status:** approved pre-alpha replacement contract for the enhancement pipeline.

**Shared recovery authority:** [Structured Output Recovery Design](../superpowers/specs/2026-07-13-recursion-structured-output-recovery-design.md) and [its implementation plan](../superpowers/plans/2026-07-13-recursion-structured-output-recovery.md). That policy owns the one external correction budget for each provider result. This contract owns only Generation Review's semantic classification and the safe application of an accepted result.

Recursion currently runs separate Dialogue and Prose full-message rewrites. Both calls receive a broad preservation contract, may reproduce the input verbatim, and are retried only after Recursion detects the no-op. This produces avoidable provider cost, inconsistent second-swipe behavior, and opaque pass results.

This contract replaces that design with one structured **Generation Review and Enhancement** generation. It uses the already-generated SillyTavern response as a frozen generation artifact, evaluates turn fulfillment, installed card guidance, scene execution, narrative quality, and anti-slop against the actual Recursion context used for the turn, and returns exact bounded replacements. Recursion applies those replacements deterministically.

The primary goal is not to make every response generically more ornate. It is to make one enabled Enhancement operation materially useful, card-aware, attributable, safe, and observable.

## Product contract

### Inputs

The enhancement snapshot is frozen before the model call. It contains:

- The base assistant response and its content hash.
- The latest user turn plus the bounded enhancement context window.
- The resolved Prompt Packet, Last Brief, story form, and generation-time installed-hand manifest.
- Character evidence used for dialogue judgment: description and example dialogue.
- The versioned anti-slop profile and generation-review schema version.

The model assesses the finished response, not an abstract prompt. It may use cards and the Prompt Packet to identify a contradiction or a locally repairable omission, but it must not force every active card into visible prose. Cards remain conditional guidance; they are not a checklist of phrases that must appear. Only cards that were installed in the generation-time Prompt Packet are review obligations.

### Outputs

The provider returns a compact evidence ledger and a list of exact replacements. It does **not** return a re-serialized copy of the entire assistant message.

```json
{
  "schema": "recursion.generationReview.v1",
  "sourceHash": "sha256:...",
  "assessment": {
    "turnResponse": { "status": "pass", "detail": "Responds directly to the current question." },
    "sceneContract": { "status": "pass", "cardRefs": [] },
    "narrativeExecution": { "status": "revised", "detail": "One beat-level pacing repair." },
    "antiSlop": { "status": "revised", "detail": "Two grounded replacements." }
  },
  "cardOutcomes": [
    {
      "cardId": "room-boundary",
      "status": "repaired",
      "evidenceTargetIds": ["beat:1"]
    }
  ],
  "reviewDomains": {
    "turnFulfillment": "pass",
    "cardAndSceneFidelity": "revised",
    "narrativeExecution": "revised",
    "antiSlop": "revised"
  },
  "patches": [
    {
      "id": "beat:1",
      "domain": "narrative-execution",
      "before": "The EMH sat with his arms folded, watching the exchange. Carter hesitated in the doorway.",
      "after": "The EMH watched with folded arms. Carter stopped in the doorway, hand still on the frame.",
      "reason": "Restores the immediate boundary pressure while tightening repeated staging.",
      "cardRefs": ["active-cast:speaker-roles"]
    }
  ]
}
```

`reason` is a short user-safe explanation, never provider chain-of-thought. `cardRefs` identify only the applicable evidence used to justify a change. `cardOutcomes` distinguish card generation/installation from actual influence in the completed SillyTavern response.

### Valid outcomes

The source is preflighted locally before any provider request.

| Situation | Provider call | Pass result |
| --- | --- | --- |
| Enhancement disabled | No | `skipped` |
| Response has no valid bounded target | No | `skipped/no-eligible-target` |
| Review finds one or more valid bounded repairs | Yes | `applied` |
| Review has a documented outcome-label alias | No | Normalize the alias, then validate normally. |
| Review has missing/invalid installed-card outcome coverage but safe patches | One shared semantic correction request with the complete installed-card ledger | `partial-failed` if coverage remains unresolved; safe patches may still apply. |
| Review has unsafe patch shape, target, source, or overlap | One shared correction only when structural recovery has not already spent it | `validation-failed`; no unsafe patch applies. |
| Provider error or invalid schema | One shared structured-output correction only when eligible | `provider-failed` or `validation-failed` |
| Material turn/scene contradiction cannot be repaired locally | No local patch for that issue | `requires-regeneration` evidence result |

### Request-known metadata recovery

Some connection-profile providers intermittently omit machine-envelope metadata even when the returned reviewer payload contains its actual semantic work. Recursion may restore the **missing only** `schema` and `sourceHash` values from the immutable request, and default omitted display-only `assessment` and `reviewDomains` to empty objects. This recovery is allowed only for `generationReviewer` responses that already contain array-shaped `cardOutcomes` and `patches`. A nonempty mismatched source hash, malformed patch list, malformed ledger, unknown card ID, incomplete coverage, invalid status, or unsafe target still fails the normal validator; no provider response gains authority merely because the envelope is completed locally.

For Connection Manager requests, `machineJson` also requires `extractData: false`. SillyTavern's extracted-data path attempts its own JSON parse and substitutes `{}` when it cannot parse a provider's visible text. That destroys the response Recursion needs for its parser and one bounded correction request. Recursion instead receives the raw Connection Manager envelope, extracts visible content itself, and keeps the normal parser, schema, and semantic validation sequence authoritative. Non-machine generation continues to use SillyTavern's extracted-data behavior.

An enabled Enhancement review with a repairable defect must not silently succeed without a patch. Conversely, a response with no valid bounded target must not incur a paid model call merely to establish that fact.

### Partial-result policy

The first combined result may contain a valid narrative patch while omitting a repairable card-fidelity or anti-slop ledger entry. Recursion preserves only independently safe patches, then spends at most one shared correction request against the **same frozen source, target IDs, review snapshot, and pipeline provenance**. That request is selected by the Structured Output Recovery policy: raw reformat for complete damaged JSON, schema correction for a role contract mismatch, or semantic correction for a structurally valid but incomplete review ledger. A normal enhancement therefore uses one provider call; a deficient first result can use at most one corrective provider request total.

If the permitted correction still leaves a repairable review finding unresolved, Recursion may apply the independently safe patches, but the overall enhancement outcome is `partial-failed`, never `success` or a generic `caution`. The correction repeats the complete installed-card ledger because the validator always requires one outcome for every installed card; it never asks the provider for only the malformed entry. The progress tree is explicit: resolved domains are green; unresolved findings are red with their reason. `replace` and `as-swipe` use the same policy, so the user can see and retain a valid paid-for improvement without mistaking it for a complete review result. Any unsafe patch invalidates the provider result rather than being selectively applied.

## Generation review scope

The Reasoner evaluates four related concerns in one coherent pass. These are review dimensions; the UI exposes one Enhancement action rather than individual Prose or Dialogue controls.

1. **Turn fulfillment:** Does the assistant respond to the latest user action or question instead of evading, restating it, or jumping beyond it?
2. **Card and scene fidelity:** Does the response contradict the installed Prompt Packet, applicable scene facts, or relevant installed-card guidance? An omission counts only when the missing fact is immediately required for comprehension or the next beat.
3. **Narrative execution:** Do dialogue, character voice, prose, pacing, subtext, staging, and causality work together for this scene?
4. **Anti-slop:** Does the response rely on repeated, generic, unsupported, or contextually inappropriate language rather than specific scene action?

The model may repair only locally entailed defects. A missing answer to the user, major scene contradiction, or missing essential beat is not safely repaired by an incidental line edit. The assessment records `requires-regeneration`; a future corrective-swipe policy may use that evidence to request a deliberate new generation.

### Custom-card review rules

The review snapshot persists the active deck ID, deck revision hash, installed-card IDs, card names, categories, selection states, packet references, and source-card lineage. It never grades a response against current mutable deck settings.

- Categories are organizational only. The reviewer must not infer obligations from a custom category name.
- A draft, inactive, priority-overflow, or Auto-omitted card is not a review obligation.
- An Active card is reviewed only if it entered the installed hand.
- A Priority card receives stronger review attention because it was forced ahead of normal Auto backfill; it is still `not-applicable` when its guidance genuinely does not bear on this beat.
- Fused guidance must preserve individual `sourceCardIds` and coverage metadata, so a successful category bundle never falsely proves individual custom-card influence.
- Custom `promptText` is delimited context. It cannot override the JSON schema, review rules, or provider safety contract.

Each applicable card must report one of `honored`, `repaired`, `not-applicable`, `partially-reflected`, `violated`, or `requires-regeneration`. This is output-influence evidence, not a claim about whether its source card call ran successfully.

### Anti-slop taxonomy

Move the existing common slop list from a phrase blacklist into versioned review classes:

| Class | Examples | Rule |
| --- | --- | --- |
| Interaction traps | fake choice endings, canned questions, parroting | Repair directly unless literal phrasing is required by the current user turn. |
| Contextual voice failures | unsupported technical diction, tsundere deflection, stock romance language | Repair only when character, card, or genre evidence does not support it. |
| Repetition loops | breath, throat, gaze, jaw, pause, micro-gesture loops | Repair when repeated, clustered, or used in place of visible action. |
| Empty atmosphere | generic tension, light, scent, and abstraction filler | Repair when it substitutes for concrete staging or pressure. |
| Intentional style | card-supported or genre-specific diction | Preserve when evidence shows it is purposeful. |

Anti-slop repairs must be grounded in the response's scene, character behavior, or applicable installed guidance. Replacing one list phrase with a neighboring cliché is invalid. The anti-slop profile version is part of the review schema and cache identity.

## Deterministic target model

Recursion owns target construction. Provider-written offsets are prohibited.

```js
// src/enhancement-review.mjs
export function buildEnhancementTargets(text = '') {
  const dialogue = dialogueSpans(text).map((span, index) => ({
    id: `dialogue:${index + 1}`,
    domain: 'dialogue',
    start: span.start,
    end: span.end,
    before: span.text
  }));

  const prose = narrationSentenceSpans(text, dialogue).map((span, index) => ({
    id: `prose:${index + 1}`,
    domain: 'narrative-execution',
    start: span.start,
    end: span.end,
    before: span.text
  }));

  return { dialogue, prose };
}

export function eligibleReviewTargets(targets) {
  return [...targets.dialogue, ...targets.prose];
}
```

`narrationSentenceSpans` must be deterministic, preserve whitespace outside a target, and exclude quoted dialogue exactly where the target is prose-only. Generation Review does not expose writable beat ranges: broad beat rewrites create overlapping targets and make mobile progress results difficult to explain. A material beat problem becomes `requires-regeneration`; bounded dialogue and prose targets remain the only writable surface. Parser tests cover nested quotes, em-dash dialogue, messages with no dialogue, and multi-paragraph prose.

## Request builder

Replace `buildDialogueEnhancementRequest` and `buildProseEnhancementRequest` with one `buildGenerationReviewRequest`. The request asks for evidence-backed patches, not a philosophical judgment about whether the source deserves revision.

```js
export const GENERATION_REVIEW_SCHEMA = 'recursion.generationReview.v1';

export function buildGenerationReviewRequest({
  sourceText,
  sourceHash,
  targets,
  reviewSnapshot,
  contextContract,
  retry = null,
  lane = 'utility',
  ...reasoning
} = {}) {
  const eligible = eligibleReviewTargets(targets);
  const installedCardIds = reviewSnapshot.installedHand.map((card) => card.cardId);
  const cardOutcomes = installedCardIds.map((cardId) => ({ cardId, status: 'honored', evidenceTargetIds: [] }));
  return {
    lane,
    ...reasoning,
    responseSchema: GENERATION_REVIEW_SCHEMA,
    machineJson: true,
    responseLength: 3200,
    prompt: [
      'Return a Recursion Generation Review and Enhancement result as strict JSON.',
      'Review the completed assistant response against its frozen generation context.',
      'Return replacements only for the listed target IDs. Never return a full rewritten message.',
      'Assess turn fulfillment, installed card and scene fidelity, narrative execution, and anti-slop.',
      'Only installed cards are review obligations. Do not force every card into visible prose.',
      'Return exactly one cardOutcomes object for every installed card in the frozen review snapshot. cardId values must match exactly.',
      'Allowed card outcome statuses: honored, repaired, not-applicable, partially-reflected, violated, requires-regeneration.',
      'Use dialogue or prose targets only when the change is locally supported by the frozen context.',
      'Do not invent facts, resolve pressure, add a new outcome, or force inactive or irrelevant cards into the response.',
      'If a material defect requires more than local replacement, record requires-regeneration in assessment; do not fake a repair.',
      retry ? `Mandatory retry: resolve each finding using one of: ${JSON.stringify(retry.targetIds)}. Still return the complete cardOutcomes array.` : '',
      `<source_hash>${sourceHash}</source_hash>`,
      `<eligible>${JSON.stringify(eligible)}</eligible>`,
      `<targets>${JSON.stringify(targets)}</targets>`,
      `<card_outcomes_template>${JSON.stringify(cardOutcomes)}</card_outcomes_template>`,
      `<review_snapshot>${serializeGenerationReviewSnapshot(reviewSnapshot, contextContract)}</review_snapshot>`,
      `<source>${sourceText}</source>`,
      `Return {"schema":"${GENERATION_REVIEW_SCHEMA}","sourceHash":"${sourceHash}","assessment":{},"cardOutcomes":${JSON.stringify(cardOutcomes)},"reviewDomains":{},"patches":[]}.`
    ].filter(Boolean).join('\n')
  };
}
```

The review snapshot contains the resolved Prompt Packet, Last Brief, story form, installed custom/bundled card manifest, source-card lineage, and bounded scene context. These are authoritative because they represent what was actually installed for the generation. The request uses a size-bounded, secret-redacted form of them. The raw provider response, API secrets, and hidden reasoning remain outside the request and all player-visible diagnostics.

## Validation and application

Validation is responsible for contract truth. `changePlan.changed`-style self-reporting is not trusted.

```js
export function validateGenerationReviewResult(result, { sourceHash, targets, reviewSnapshot }) {
  if (result?.schema !== GENERATION_REVIEW_SCHEMA) {
    return fail('RECURSION_GENERATION_REVIEW_SCHEMA_MISMATCH');
  }
  if (result.sourceHash !== sourceHash) return fail('RECURSION_GENERATION_REVIEW_STALE_SOURCE');

  const targetById = new Map(eligibleReviewTargets(targets).map((target) => [target.id, target]));
  const installedCardIds = new Set(reviewSnapshot.installedHand.map((card) => card.cardId));
  const patches = Array.isArray(result.patches) ? result.patches : [];
  const seen = new Set();
  const cardOutcomeStatuses = new Set([
    'honored', 'repaired', 'not-applicable', 'partially-reflected', 'violated', 'requires-regeneration'
  ]);

  for (const patch of patches) {
    const target = targetById.get(patch?.id);
    if (!target || !['dialogue', 'narrative-execution', 'anti-slop', 'card-fidelity'].includes(patch?.domain) || seen.has(target.id)) {
      return fail('RECURSION_GENERATION_REVIEW_TARGET_INVALID');
    }
    if (patch.before !== target.before || !String(patch.after || '').trim() || patch.after === patch.before) {
      return fail('RECURSION_GENERATION_REVIEW_PATCH_INVALID');
    }
    seen.add(target.id);
  }

  const patchedTargets = patches.map((patch) => targetById.get(patch.id)).sort((left, right) => left.start - right.start);
  for (let index = 1; index < patchedTargets.length; index += 1) {
    if (patchedTargets[index].start < patchedTargets[index - 1].end) {
      return fail('RECURSION_GENERATION_REVIEW_PATCH_OVERLAP');
    }
  }

  const outcomeByCardId = new Map();
  for (const outcome of Array.isArray(result.cardOutcomes) ? result.cardOutcomes : []) {
    if (!installedCardIds.has(String(outcome?.cardId || ''))) {
      return fail('RECURSION_GENERATION_REVIEW_CARD_NOT_INSTALLED');
    }
    const status = normalizeCardOutcomeStatus(outcome?.status);
    if (!cardOutcomeStatuses.has(status)) {
      return fail('RECURSION_GENERATION_REVIEW_CARD_OUTCOME_INVALID', { retryable: true });
    }
    if (outcomeByCardId.has(outcome.cardId)) {
      return fail('RECURSION_GENERATION_REVIEW_CARD_OUTCOME_DUPLICATE', { retryable: true });
    }
    outcomeByCardId.set(outcome.cardId, { ...outcome, status });
    for (const targetId of Array.isArray(outcome?.evidenceTargetIds) ? outcome.evidenceTargetIds : []) {
      if (!targetById.has(String(targetId))) return fail('RECURSION_GENERATION_REVIEW_CARD_EVIDENCE_INVALID');
    }
  }

  const missingCardIds = [...installedCardIds].filter((cardId) => !outcomeByCardId.has(cardId));
  if (missingCardIds.length) {
    return fail('RECURSION_GENERATION_REVIEW_CARD_OUTCOME_MISSING', {
      retryable: true,
      missingCardIds,
      safePatches: patches
    });
  }

  const requiresRegeneration = Array.isArray(result.cardOutcomes)
    && result.cardOutcomes.some((outcome) => outcome?.status === 'requires-regeneration');
  if (patches.length === 0 && !requiresRegeneration) {
    return fail('RECURSION_GENERATION_REVIEW_NO_PATCH');
  }

  return {
    ok: true,
    patches,
    assessment: result.assessment || {},
    cardOutcomes: [...outcomeByCardId.values()],
    reviewDomains: result.reviewDomains || {},
    requiresRegeneration
  };
}

export function applyGenerationReviewPatches(sourceText, patches, targets) {
  const byId = new Map(eligibleReviewTargets(targets).map((target) => [target.id, target]));
  return [...patches]
    .sort((left, right) => byId.get(right.id).start - byId.get(left.id).start)
    .reduce((text, patch) => {
      const target = byId.get(patch.id);
      return `${text.slice(0, target.start)}${patch.after}${text.slice(target.end)}`;
    }, sourceText);
}
```

Additional validator rules:

- Enforce a per-domain and aggregate edit-ratio ceiling; start with the current 30% soft policy as a hard safety ceiling only after target-level metrics are measured.
- Reject duplicate, overlapping, unknown, stale, empty, or source-mismatched patches.
- Require at least one valid bounded patch whenever the reviewer identifies a repairable defect. A no-patch result receives one retry against the same frozen source and target set; it cannot become a success by self-reporting that the source was acceptable.
- Preserve source formatting outside patched targets and re-parse dialogue after application.
- Re-check story-form invariants where they can be detected deterministically: no altered quoted dialogue from a Prose patch; no narration altered by a Dialogue patch.

## Runtime integration

The existing enhancement entry point in `src/runtime.mjs` remains responsible for hold/reveal, As Swipe insertion, marker persistence, cache identity, provider fallback, and cancellation. Replace only its sequential `passSequence` loop.

```js
const targets = buildEnhancementTargets(originalText);
const reviewSnapshot = buildGenerationReviewSnapshot({
  source: { messageId, swipeId: identity.swipeId, text: originalText, hash: originalHash },
  deck: deckManifestForGeneration(lastPacket, settings),
  installedHand: installedHandManifest(lastHand, lastPacket),
  promptPacket: lastPacket,
  lastBrief: lastBriefForGeneration(lastPacket),
  storyForm,
  context: enhancementContext,
  antiSlopProfileVersion: ANTI_SLOP_PROFILE_VERSION
});
const eligibleTargets = eligibleReviewTargets(targets);

if (!eligibleTargets.length) {
  return settleEnhancementSkipped({ runId, reason: 'no-eligible-target' });
}

const request = buildGenerationReviewRequest({
  sourceText: originalText,
  sourceHash: originalHash,
  targets,
  reviewSnapshot,
  contextContract,
  lane: enhancementLane,
  ...enhancementReasoning
});

const generation = await generationRouter.generate('generationReviewer', request);
let validation = generation.ok === true
  ? validateGenerationReviewResult(generation.data, {
      sourceHash: originalHash,
      targets,
      reviewSnapshot
    })
  : { ok: false, retryable: false, error: generation.error };
if (!validation.ok && generation.recoverySpent !== true && validation.retryable === true) {
  const retryRequest = buildGenerationReviewRequest({
    ...request,
    retry: {
      targetIds: validation.invalidTargetIds || eligibleTargets.map((target) => target.id),
      cardIds: validation.missingCardIds || validation.invalidCardIds || []
    }
  });
  const retry = await generationRouter.generate('generationReviewer', {
    ...retryRequest,
    structuredRecovery: { kind: 'semantic_correction_retry', priorResult: generation.data }
  });
  validation = retry.ok === true ? validateGenerationReviewResult(retry.data, {
    sourceHash: originalHash,
    targets,
    reviewSnapshot
  }) : { ok: false, retryable: false, error: retry.error };
}

if (!validation.ok && !validation.safePatches?.length) return settleEnhancementFailure({ runId, validation });
if (validation.requiresRegeneration && !validation.patches.length) {
  return settleEnhancementRequiresRegeneration({ runId, validation });
}

const enhancedText = applyGenerationReviewPatches(originalText, validation.safePatches || validation.patches, targets);
const outcome = validation.requiresRegeneration || !validation.ok ? 'partial-failed' : 'applied';
```

Provider routing remains `enhancementLaneForSettings`: high and ultra may use Reasoner, and a failed Reasoner call can fall back to Utility using the same schema. The new contract must not depend on a provider's marketing label; only the capability to produce valid structured patches matters.

### Swipe and cache integration

The enhancement cache key must include:

- `sourceHash`, source message ID, swipe ID, and source revision hash.
- Requested domain flags and enhancement mode (`replace` or `as-swipe`).
- Resolved Prompt Packet/Last Brief hash, relevant active-card identity, story-form hash, and bounded enhancement context identity.
- Provider settings signature and schema version.

Reuse is valid only if the frozen enhancement snapshot is identical. A cached result restores the validated patch ledger and per-domain statuses; it never replays an unvalidated provider response. A force-fresh reset bypasses this cache as specified by the global cache policy.

## Progress, status, and diagnostics

The progress tree has one actual provider node and stable review-domain children derived from validated results. Create every row when the operation starts; update by stable step ID rather than rebuilding the menu on a refresh heartbeat:

```text
Enhancing                          Reviewing generated response...
  Capturing source response         running | success | cached | caution | failed
  Generation review                 running | success | cached | caution | failed
    Turn fulfillment                waiting | passed | failed
    Card and scene fidelity         waiting | honored | repaired | caution | failed
      Scene Frame                   3 honored
      Relationship                  1 repaired
      Environment                   not applicable
    Narrative execution             waiting | revised | caution | failed
    Anti-slop                       waiting | revised | caution | failed
  Applying revisions                waiting | success | failed
  Enhanced swipe                    waiting | added | skipped | failed
```

- The bar reports concise significant events: `Reviewing generated response...`, `Checking active card influence...`, `Applying 3 grounded revisions...`, and `Enhanced swipe ready.`
- Cyan is running only. Green is verified success. Purple is a restored valid cache result. Yellow is an explicit unresolved caution with an inspectable reason. Red is provider, validation, application, or material generation failure. Gray is waiting, disabled, or not applicable.
- Rows retain gray text; indicators and right-side labels carry state.
- Card children appear only for generation-time installed cards. `honored` and `repaired` are green; `not-applicable` is gray; `partially-reflected` is yellow only with its concrete reason; `violated` and `requires-regeneration` are red.
- `skipped/no-eligible-target` is gray and explicit; it is not a green success and not a caution.
- A cached review restores its validated patch ledger and domain/card outcomes as purple cache states; it must never claim fresh provider work.
- Provider failure, invalid patch, unchanged-after-retry, failed application, and required regeneration are red with a specific reason code in the progress detail and run journal.
- The main Recursion status bar receives the concise significant event. Do not add yellow status rows to the cards/decks UI.
- On mobile, the same fixed-row tree scrolls inside the popover. Tap expands a row; press-and-hold exposes truncated detail. The page must not move as states change.

Example journal payload:

```js
await appendJournalSafe(runId, identity.chatKey, {
  event: 'generation.review',
  severity: validation.ok ? 'info' : 'error',
  summary: 'Generation review completed.',
  details: {
    sourceHash: originalHash,
    reviewDomains: validation.reviewDomains,
    cardOutcomes: validation.cardOutcomes,
    patchCount: validation.patches?.length || 0,
    assessment: publicAssessment(validation.assessment)
  }
});
```

## Files and migration

| File | Change |
| --- | --- |
| `src/generation-review.mjs` | New schema, target segmentation, anti-slop profile, request builder, validation, patch application, card-outcome validation, and public-assessment helpers. |
| `src/runtime.mjs` | Replace the sequential full-message Dialogue/Prose loop with one review call, one capped retry, generation-snapshot persistence, cache identity, and review progress. |
| `src/dialogue-enhancement.mjs` | Move reusable dialogue detection rules into generation-review helpers, then remove the full-message request/validator path. |
| `src/prose-enhancement.mjs` | Move `dialogueSpans` and the common slop list into generation-review helpers, then remove the full-message request/validator path. |
| `src/card-decks.mjs`, `src/cards.mjs` | Expose a stable generation-time deck/installed-hand manifest and preserve individual source-card lineage through Standard and Fused results. |
| `src/enhancement-context.mjs` | Supply bounded Prompt Packet, Last Brief, installed-card evidence, character evidence, and context identifiers. |
| `src/progress.mjs`, `src/ui.mjs`, `src/ui/view-model.mjs` | Render the fixed Generation Review tree, card-outcome children, concise detail, and truthful cached/partial/failure states. |
| `src/settings.mjs` and user docs | Replace separate Prose/Dialogue user controls and copy with one Enhancement operation. |
| Tests and fixtures | Replace old enhancer schema fixtures and assertions. |

This is a pre-alpha contract replacement. Remove obsolete `recursion.dialogueEnhancer.v1` and `recursion.proseEnhancer.v1` paths, feature controls, fixtures, and documentation rather than preserving compatibility adapters.

## Validation plan

### Unit and contract tests

- Target segmentation: dialogue-only, prose-only, mixed prose/dialogue, nested punctuation, contiguous beat ranges, and whitespace preservation.
- Card-outcome contract: each accepted enum value and alias; unsupported values such as `included`; duplicate, missing, and uninstalled card IDs; and evidence-target validation.
- Request builder: source hash, only bounded/redacted context, installed-hand manifest, Prompt Packet, Last Brief, anti-slop profile version, and stable target IDs.
- Validator: schema mismatch, stale source, unknown/duplicate target, invalid patch domain, unchanged replacement, empty replacement, overlapping patches, non-installed card outcome, and no-patch output without `requires-regeneration`.
- Application: descending replacement order, unchanged surrounding text, post-application dialogue/prose invariants, and bounded beat replacement.
- Anti-slop: direct interaction traps; repetition/density detection; intentional custom-card and character-voice exceptions; no neighboring-cliché substitution.
- Cache: identical frozen snapshot reuses validated review results; source, context, Packet, installed hand, deck revision, selection/order, provider settings, schema, or anti-slop profile change invalidates reuse.

### Runtime tests

- One Enhancement action makes one provider call when a valid source target exists.
- No eligible target skips without a provider call.
- A no-patch result triggers exactly one targeted retry and then fails honestly unless it reports a validated `requires-regeneration` result.
- A valid local patch plus a material `requires-regeneration` result reports `partial-failed` truthfully and never calls it success.
- Custom card outcomes distinguish installed, active-but-omitted, priority-overflow, draft, bundled, authored, and fused-source lineage correctly.
- Replace and As Swipe preserve the original message and write the generation-review marker with source hash, patch ledger hash, review domains, card outcomes, and cache identity.
- Cancellation, provider Reasoner-to-Utility fallback, cache hit, and forced-fresh behaviors preserve the same visible contract.

### Live SillyTavern and Playwright validation

Run each test against the installed extension copy and a real configured provider:

1. Generate a response with each pipeline: Standard, Rapid, and Fused.
2. Run the single Enhancement As Swipe path and confirm its bounded revision is visible in the selected swipe.
3. Confirm one review provider call per eligible enhancement, or one semantic correction after a contract violation; verify exact review-domain statuses, complete individual installed-card outcomes, and anti-slop findings in the progress tree.
4. Exercise Standard, Rapid, and Fused custom-deck paths; verify a card appears in review only when it was installed and that Fused source-card children retain correct lineage.
5. Confirm a repeated identical swipe reuses the validated review result when its cache contract permits it; verify purple cached states.
6. Confirm a changed source message, changed card/deck state, changed enhancement context depth, changed anti-slop profile, and force-fresh action bypass cache.
7. Capture desktop and mobile screenshots. Verify the progress tree remains compact, status text is truthful, rows do not flicker across refresh heartbeats, and no success color is shown for skipped or unvalidated work.
8. Inspect the run journal and Last Brief/Prompt Packet evidence to confirm the report matches the exact generation-time installed context.

## Implementation sequence

1. Add generation snapshot/installed-hand manifest capture, anti-slop profile, target segmentation, and schema with exhaustive unit tests.
2. Add request building, card-outcome validation, beat-level patch validation, and deterministic application tests.
3. Replace the runtime's sequential loop while preserving existing hold/reveal, As Swipe, cancellation, and provider fallback pathways.
4. Migrate cache markers and run-journal entries to the generation-review ledger contract.
5. Update progress/UI view models and replace separate Prose/Dialogue controls with one Enhancement operation.
6. Remove legacy full-message enhancer modules, schemas, fixtures, tests, and docs.
7. Run focused tests, the full test suite, installed-copy verification, and the three-pipeline Playwright live matrix before declaring the migration complete.
