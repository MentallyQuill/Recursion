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
- Manual `generation_stopped` previously cleared volatile runtime state, so Last Brief and Prompt Packet could disappear after an early stop. Stop handling now clears host prompt keys while preserving `lastPacket`, `lastHand`, plan, and snapshot.
- Installed prompt sections were too meta-facing for the final model. Guidance/card evidence are now framed as private Recursion material for the next assistant message, with explicit normal prose/dialogue output guidance and hidden-label guardrails.
- Rapid warm artifacts self-staled because `cacheContractVersions()` did not provide the `promptContractHash` that Rapid usability required. The prompt contract hash is now explicit and stored in scene cache/Rapid artifacts.
- Live provider card outputs needed request-owned tolerance: missing envelope identity, `roleId`, `cards`, missing snapshot hash, missing evidence refs, and out-of-window message refs are repaired only under active request guards. Explicit wrong role/family/hash and non-message evidence still reject.
- Rapid foreground rejected exact warm artifacts with sparse SillyTavern source ranges. Sparse source ranges are now allowed only for exact Rapid warm-card consumption; Standard cache validation remains strict.
- The live proof harness now waits for a newly installed packet rather than accepting preserved Last Brief state, and uses a gated runtime handle for deterministic Standard/Rapid setting control.

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

Alpha gate result: 20 scripts passed, Playwright readiness passed, recursion alpha gate passed.

## Live SillyTavern Verification

Live target:

- Base URL: `http://127.0.0.1:8000`
- User: `recursion-soak-a`
- Served extension path: `F:\SillyTavern\SillyTavern\public\scripts\extensions\third-party\Recursion`
- Before live proof, changed source files were copied to the served extension path and hash-checked against the checkout.

Passed:

- `node tools\scripts\prove-live-prompt-packet.mjs --live --pipeline standard`
  - Result: `live-prompt-packet-proof-pass`
  - Packet id: `prompt-packet-mr4mto4m-o32gi3`
  - Provider request roles: `utilityArbiter`, `card`, `guidanceComposer`
  - Installed keys: `recursion.guidance`, `recursion.cardEvidence`, `recursion.guardrails`
  - Prompt keys cleared after synthetic `generation_stopped`
  - Last Brief remained visible after stop

- `node tools\scripts\prove-live-prompt-packet.mjs --live --pipeline rapid`
  - Result: `live-prompt-packet-proof-pass`
  - Packet id: `prompt-packet-mr4msk3x-ys9fpj`
  - Diagnostics: `pipelineMode: rapid`, `rapidPath: warm-v2`
  - Installed keys: `recursion.guidance`, `recursion.cardEvidence`, `recursion.guardrails`
  - Prompt keys cleared after synthetic `generation_stopped`
  - Last Brief remained visible after stop
  - Rapid prompt carried warm guidance plus raw selected card evidence; no `conditionedSceneBrief`, `rapidFastStartPack`, `Scene brief:`, or `Turn brief:` leaked.

## Remaining Risk

No remaining live pipeline gap found in this pass. Standard and Rapid both installed V3 prompt packets into the live SillyTavern prompt surface, and Rapid proved `warm-v2` end to end.
