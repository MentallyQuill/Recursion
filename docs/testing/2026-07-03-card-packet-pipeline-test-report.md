# Card Packet Pipeline Revision Test Report

Date: 2026-07-03

## Scope

This report covers the Prompt Packet V3 and Rapid Pipeline V2 revision:

- Standard packet sections are now `Guidance`, `Card Evidence`, and `Guardrails`.
- Selected raw card `promptText` is preserved in `recursion.cardEvidence`.
- `guidanceComposer` replaces the old Utility brief-composer contract.
- Rapid warm artifacts store provider guidance plus selected card ids, not `conditionedSceneBrief`.
- Rapid warm miss escalates to Standard; summary-only fast-start is removed from the quality path.

## Fixed Findings

- `conditionedSceneBrief` was raw selected card text joined and sliced, not provider-composed guidance. Rapid warm V2 now stores `guidance` and `selectedCardIds`.
- The prompt packet no longer collapses cards into local Scene/Turn briefs. It keeps raw selected card evidence and adds provider direction.
- Current docs, UI strings, progress rows, provider roles, tests, and prompt keys were updated to the V3 contract.
- Source compatibility aliases for old Rapid fields were removed from `src/rapid-pipeline.mjs`.

## Deterministic Verification

Passed:

- `node tools\scripts\test-providers.mjs`
- `node tools\scripts\test-prompt.mjs`
- `node tools\scripts\test-rapid-pipeline.mjs`
- `node tools\scripts\test-progress.mjs`
- `node tools\scripts\test-ui.mjs`
- `node tools\scripts\test-runtime.mjs`
- `node tools\scripts\test-storage.mjs`
- `node tools\scripts\test-host.mjs`
- `node tools\scripts\test-extension-smoke.mjs`
- `node tools\scripts\test-settings-policy.mjs`
- `node tools\scripts\test-live-harness.mjs`
- `node tools\scripts\test-model-eval-harness.mjs`
- `node tools\scripts\run-alpha-gate.mjs`

Alpha gate result: 19 scripts passed, Playwright readiness passed, recursion alpha gate passed.

## Live SillyTavern Verification

Live target:

- Base URL: `http://127.0.0.1:8000`
- User: `recursion-soak-a`
- Served extension path: `F:\SillyTavern\SillyTavern\public\scripts\extensions\third-party\Recursion`
- Before live proof, changed source files were copied to the served extension path and hash-checked against the checkout.

Passed:

- `node tools\scripts\prove-live-pipelines.mjs --live --pipeline standard`
- Run id: `pipeline-mr4iinha`
- Result: `live-pipeline-proof-pass`
- Evidence: visible send created one user message and one assistant response, `Recursion prompt ready.`, `Hand 1`, no browser console/page issues.
- Installed prompt packet used V3 keys: `recursion.guidance`, `recursion.cardEvidence`, `recursion.guardrails`.

Rapid live result:

- Rapid no longer used fast-start. Warm misses escalated through Standard with `rapid-warm-miss-standard`.
- `warm-v2` was not live-proven in this environment. The live Utility provider did not produce accepted provider cards for the Rapid warm pass, so the proof ended with `Rapid deck stale.` instead of a ready warm artifact.
- This is an environment/provider coverage gap, not a deterministic contract failure. The focused runtime tests prove `warm-v2` install behavior with accepted provider cards.

## Remaining Risk

The deterministic contract is green. The remaining live gap is provider-quality dependent: a real host/provider route must return valid card JSON during Rapid warm before live `warm-v2` can be proven end to end.
