# Refinement review assessments

Approved scope: strengthen the existing review and push to main. Keep the same review/revise/verify graph and calls. No single-pass redesign or new provider settings.

The review item adds `assessment: { status, summary, evidenceRefs, supportingCardIds }`. Status is `satisfied`, `not-applicable`, or `needs-work`; the first two require accept, the last requires revise. Summary is one short scene-specific sentence, at most 400 characters. Use 1-3 visible message references and 0-3 actual selected result IDs. Satisfied requires at least one supporting result. A peer can satisfy an instruction only when explicitly cited; generic uncertainty language does not establish a specific application. Contextually unnecessary work may be not-applicable with evidence. Findings remain actionable revision instructions.

Keep the final assessment on per-target hand metadata for the Viewer and opted-in excerpts. Compact execution/progress/packet diagnostics expose only IDs, counts and outcomes. Assessments must not enter narrator guidance or card bodies. Invalidate prior contracts/checkpoints; no compatibility shim for unchecked accept items.

- [x] Root: add failing contract tests, update prompt/schema/validation, persist final assessment, sanitize compact summaries and invalidate old contracts.
- [x] UI worker: render bounded assessment and references beneath existing Viewer outcomes; update UI/design docs and focused tests, verify isolated browser.
- [x] Root: update runtime/provider fixtures, test unchanged/revised results in both modes with identical call counts, and ensure assessments do not enter narrator/compact diagnostics.
- [x] Independent review, full offline suite, integrate current main, commit and push, verify GitHub SHA.

Delivered on main at `b1d49758`, verified through the GitHub API. All 105 offline test scripts passed on the combined result, including current main's instruction-line preservation fix. Isolated browser checks at 1000px and 390px verified assessment display, refresh, bounded content, and inert markup. Independent review findings were corrected and rechecked: accepted targets depending on revised peers join the existing verification call, and draft prompts omit review-only output instructions.

Verification limitation: deterministic tests prove contracts and orchestration, not live-model defect detection. No provider calls will be added or silently run for evaluation.
