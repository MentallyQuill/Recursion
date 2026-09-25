# Guidance validation implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this approved plan inline.

**Goal:** Accept bounded protective Guidance, reject disclosure instructions, and make existing correction attempts and diagnostics explain the rejected category.

**Architecture:** Keep the shared instruction matcher deterministic. Preserve line boundaries through Guidance composition, return one semantic validation result, and carry allowlisted rule identifiers through durable execution and diagnostic export.

**Tech Stack:** JavaScript ES modules, Node offline test scripts.

**Spec:** User-approved fix scope in this task; existing contracts in `docs/architecture/PROMPT_COMPOSITION_SPEC.md` and `docs/technical/STORAGE_AND_DIAGNOSTICS.md`.

## Constraints

- No extra provider calls or expanded retry limits.
- Exhausted invalid Guidance pauses narration; valid upstream checkpoints remain reusable.
- No raw rejected prose in diagnostic metadata or correction feedback.
- Keep disclosure requests rejected even when appended to a protective clause.
- Update the current contract in place; no legacy compatibility paths.

## Review focus

- Qualified prohibitions and coordinated objects must survive the entire packet path.
- Newlines inside forbidden phrases must not bypass validation.
- Bullets and newlines separating instructions must not turn safe prose into invalid prose.
- Mixed prohibitions and disclosure instructions must fail.
- Diagnostic identifiers must survive persistence while unknown values are omitted.

## Tasks

- [x] Extend `tools/scripts/test-instruction-safety.mjs` with `Do not invent hidden motives for Harry.`; run `node tools/scripts/test-instruction-safety.mjs` red, then extend the bounded protective grammar in `src/instruction-safety.mjs` and rerun green. Repeat for evidence qualifications and coordinated objects, including the built-in Guidance instruction.
- [x] Add multiline Guidance packet coverage to that test. Preserve line boundaries in `src/prompt.mjs` and `src/cards.mjs`; detect forbidden phrases across wrapped lines without exempting subsequent instructions. Run instruction, prompt, and card tests.
- [x] Add Guidance rejection-category assertions to `tools/scripts/test-guidance-contract.mjs`. Make `validateGuidanceResult` return the category directly, update correction instructions by category, and verify no rejected prose reaches errors or feedback.
- [x] Exercise real durable execution in `tools/scripts/test-runtime-preprocess.mjs`: reject Guidance, verify targeted correction, then verify recovery/install and exhausted pause/checkpoint reuse. Carry allowlisted validation rules through attempt classification, stage records, checkpoint normalization, and export. Add persistence/export assertions and unknown-value rejection coverage.
- [x] Update prompt and diagnostic contract docs. Run `npm.cmd test`, review the diff with a fresh reviewer while completing documentation, and resolve actionable findings. Integration follows the user-authorized push to `main`, with a remote SHA check.

## Execution record

- Baseline: clean `main`, equal to `origin/main` at `c4cdc175`; GitHub authentication valid.
- Ruling: work in the clean current checkout and push to main, as authorized; no running SillyTavern host changes.
- Diagnosis: the exported failed payload is absent. Tests reproduce independently verified validator defects, without claiming the exact live rejected phrase.

- Verification: qualified-clause, multiline, category, correction and durable-metadata tests observed red before their fixes and green afterward. Runtime coverage also proves exhausted pause, installation after correction, and Guidance-only retry with upstream reuse.
- Review: fresh reviewer identified list-boundary and conditional-name edge cases. Each was reproduced with a failing regression and fixed; bullet continuations keep exceptions attached, and matching remaining text still catches forbidden phrases split across bullets. The full 106-script offline suite passed before review fixes; a final run verifies the reviewed implementation.
- Final verification: all 106 offline test scripts pass after review fixes; diff whitespace check passes; reviewer verified the final boundary fix. No live provider run was performed.
