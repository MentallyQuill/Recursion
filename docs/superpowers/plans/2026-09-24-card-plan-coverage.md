# Card Plan Coverage Implementation Plan

> Execute inline with test-first verification; request an independent final review.

**Goal:** Built-in card IDs must remain executable generation jobs; incomplete planned hands must never install.
**Architecture:** Normalize Arbiter candidates against the active eligible deck before selection. Keep generated family jobs and authored IDs distinct. Validate the selected hand against the actual normalized plan before Guidance and prompt installation. Invalidate old prepared work through the cache contract.
**Tech stack:** JavaScript ES modules, Node assertions, durable runtime stages.
**Spec:** User-approved diagnosis and repair; existing card selection and fail-closed generation contracts.

## Constraints and review focus
- Preserve unrelated changes and the running host; push the scoped repair to main.
- Respect Off/cooldown exclusions and mandatory Priority/Refinement sources.
- Resolve ID-only and conflicting-family jobs through deck identity; reject unknown IDs.
- Merge source selections within each family without losing requested coverage.
- Preserve authored priority cards, normal below-target eligibility, and both pipelines.
- Reject missing planned output before Guidance/install; invalidate old malformed plans.

## Tasks
- [x] Reproduce built-in IDs becoming seven authored slots in a Node regression; verify failure, normalize candidate identities, verify pass.
- [x] Add targeted regressions for invalid/excluded IDs, duplicate family sources, authored priorities, and coverage diagnostics; implement each failing case.
- [x] Add runtime checks for complete planned hand coverage and pipeline integration regressions. Confirm failed preparation installs nothing.
- [x] Document behavior and obtain an independent review; finish full-suite verification before committing and pushing HEAD to main.

## Execution ledger
- Baseline started; installed locked offline dependencies after missing Playwright dependency blocked the first run.

- Reproduced the original one-of-eight failure before correction. Added ID-only, conflicting family, unknown, Off/cooldown, duplicate source and authored Priority regressions.
- Verified all eight expected families reach Guidance and installation in both pipelines, with same-turn cache reuse.
- Ruling: selected generated stages block after exhausted recovery so targeted Retry stays on the actual failed family. The final hand guard independently blocks downstream loss. Retry integration preserves accepted siblings and regenerates only the failed family and Guidance.
- Independent final review found no remaining substantive defects. Fixed-order tests now explicitly disable variety; the cache-contract change legitimately alters selection seeds.
