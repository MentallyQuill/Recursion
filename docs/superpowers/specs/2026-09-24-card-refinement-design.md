# Card Refinement design

## Intent and authorization

The user approved a fourth card state, Priority + Refinement, and explicitly authorized this spec, an implementation plan, execution, verification, and push to main without further approval requests. Refinement is a bounded recursive review of disposable scene analysis inside Recursion's preprocessing workflow. It is not character simulation, durable character memory, or prose rewriting.

## Participation and presentation

The persisted `selectionState` values are `off`, `active`, `priority`, and `refinement`. Auto cycles in that order; Manual cycles off, active, refinement, off (existing priority is equivalent to active in Manual). Refinement always forces inclusion in both modes, preserving authored deck order and the existing mandatory Priority overflow behavior. Draft and disabled cards do not run. Default-deck overrides, custom decks, duplication, export/import, and active-deck fingerprints preserve the state.

The short visible label is Refinement. The existing compact eye button uses a distinct eye with a circular arrow; tooltip: "Always included. Reviews and improves this card's scene analysis before narration." Counts distinguish Priority from Refinement while both remain mandatory. Existing bulk enable resets runnable cards to active; bulk disable turns them off. No new dashboard or provider configuration surface.

## Execution contract

With no refinement targets, retain the existing graph and provider calls. Otherwise, after hand selection and before Guidance, execute checkpointed stages: `preprocess.refinement.prepare`, `.review`, `.revise`, `.verify`, `.hand`. Use the configured Reasoner lane for model work, with existing provider transport, deadline, cancellation, correction retries, Resume, and Retry. A provider failure never silently downgrades the required work to Priority.

Prepare derives targets from marked deck card IDs and selected hand source lineage. Every marked runnable card must be accounted for. Multiple generated facets may share one family result; each marked facet gets its own review verdict, and a revision replaces that family result once. A family revision is re-reviewed against all marked facets contributing to it. The reviewer sees the frozen scene and complete selected hand to detect contradictions, but only marked results can be revised.

Authored cards currently have no generated scene result. For marked authored cards, prepare makes a model call to derive an evidence-bound scene application. The authored instruction remains authoritative and unchanged in saved settings. The final injected authored card includes its original instruction plus the accepted scene application. Unmarked authored cards retain their direct-inclusion path.

The first review is mandatory, including for a good initial result. Accepting unchanged is successful refinement; changes are not required for their own sake. A revise verdict requires specific, evidence-grounded findings. Revise only affected runtime cards using their previous result and actual review findings. Review the revisions once. V1 has one possible revision, at most two semantic reviews. Conditional stages with no work do not call a model. If the second review still requires changes, stop preparation with an actionable Refinement error; do not label rejected content accepted. Uncertainty is legitimate, not grounds for repeated revision by itself.

## Structured boundaries

Implement `src/card-refinement.mjs` as pure request/validation/result helpers, separate from execution side effects. Runtime owns the stage graph and transport.

`collectRefinementTargets(settings, hand)` returns `{ targets, cards }`; each target has `id` (deck card ID), `cardId` (selected runtime result ID), `name`, `instruction`, and `authored`. Missing coverage throws a named error. No marked cards returns empty targets.

`buildRefinementRequest({ phase, snapshot, snapshotHash, hand, targets, review })` returns a provider request with role `cardRefinementDraft` for prepare/revise or `cardRefinementReview` for review/verify, lane reasoner, responseSchema, prompt, snapshotHash, refinementCardIds, refinementTargetIds, and validEvidenceRefs. Only affected authored/runtime cards are requested for draft phases. Runtime determines target subsets for verification.

Draft schema `recursion.cardRefinementDraft.v1`: `{ schema, snapshotHash, items: [{ cardId, promptText, evidenceRefs }] }`.
Review schema `recursion.cardRefinementReview.v1`: `{ schema, snapshotHash, items: [{ targetId, verdict: 'accept'|'revise', findings: [{ message, evidenceRefs }] }] }`.

Validators reject unknown/duplicate/missing IDs, stale hashes, unsupported references, empty/oversized text, unsafe instructions, and inconsistent verdict/findings. A revise verdict needs findings; accept has none. Drafts require evidence references. Findings and intermediate cards remain local checkpoint artifacts; progress summaries expose only IDs, names, counts, and outcomes, never raw prompts or source text.

`validateRefinementResult(result, request)` returns `{ ok, value }` or `{ ok:false, error }`, preserving provider error classification. `applyRefinementDraft(hand, draft)` replaces only returned result bodies/evidence while retaining authoritative identity and lineage. `finalizeRefinementHand(originalHand, refinedHand, targets, reviews)` adds compact per-target refinement outcomes to hand metadata and original authored instructions to accepted applications. Marked facets sharing a family do not multiply hand slots.

## Review criteria

Evaluate the original instruction's scene-specific purpose, source support, character knowledge boundaries, separation of assertions and observations, unresolved assumptions, conflicts with other cards, and useful implications for the next response. Do not reward verbosity, invent corroboration, require universal rationality, or output private monologues. Include actionable findings rather than hidden deliberation. Unknown world truth remains unknown.

## Integration, freshness, and visibility

Guidance, packet evidence, Last Brief, and prepared generation must use the accepted refined hand. Do not inject superseded drafts alongside revisions. Unmarked cards remain unchanged. Changes to deck text/state/order, scene, source message, provider settings, or refinement contracts invalidate dependent checkpoints and prepared packets. Matching same-turn swipe reuse may reuse the already reviewed packet; fresh user turns require fresh evidence and review.

The progress tree exposes Preparing applications, Reviewing cards, Revising cards, Checking revisions, and Refined hand with truthful completed/unchanged/not-needed outcomes. Viewer/diagnostics expose per-target accepted outcome and revision count through bounded metadata. They must not confuse transport retries with semantic review rounds.

## Verification

Prove state persistence and Auto/Manual mandatory selection, family deduplication, authored application, no-target zero-call behavior, complete review coverage, explicit feedback in revision input, second-review rejection, malformed/stale/foreign output rejection, unchanged acceptance, original instruction preservation, and unmarked-card preservation. Runtime tests cover both Fused and Segmented, Guidance receiving accepted results, failure blocking installation, cancellation/resume, and fingerprint invalidation. UI checks cover eye cycle, counts, accessibility labels and rendered compactness. Run the full offline suite and an isolated browser rendering check; do not modify the running SillyTavern host or claim live provider quality proof.

## Scope boundaries

No new model profiles, long-term memory, per-character agents, arbitrary recursion depth, narrator rewriting, or automatic modification of custom authored instructions. The first release establishes the explicit review mechanism; narrative quality remains a separate empirical evaluation.
