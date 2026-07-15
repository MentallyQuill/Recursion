# Redirect Hard Contract And Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make explicit Redirect always attempt a validated directional replacement and recover once from provider output-token exhaustion without false success.

**Architecture:** Tighten the existing Editorial diagnosis schema and semantic validator so Redirect accepts only `proceed`, while Repair and Recompose retain current decisions. Extend the provider router's existing structured-output recovery token to cover token-limit responses with a compact retry prompt, then carry sanitized completion diagnostics through the existing journal boundary.

**Tech Stack:** JavaScript ES modules, JSON Schema request generation, Node test scripts, SillyTavern host adapter, Playwright live proof.

## Global Constraints

- Recursion is pre-alpha; update contracts in place without compatibility shims.
- Keep the semantic validator authoritative.
- Preserve frozen source, snapshot, card, and candidate identities.
- Never journal raw prompts, responses, hidden reasoning, credentials, or private Redirect analysis.
- Live proof must use a `recursion-soak-*` user and the shared strict Enhancement oracle.

---

### Task 1: Lock The Redirect Decision Contract

**Files:**
- Modify: `src/editorial-transform.mjs`
- Modify: `src/providers.mjs`
- Test: `tools/scripts/test-editorial-transform.mjs`
- Test: `tools/scripts/test-providers.mjs`

**Interfaces:**
- Consumes: `validateEditorialDiagnosis(result, fixture)` and `machineJsonSchemaForRequest(request)`.
- Produces: Redirect diagnoses whose only valid decision is `proceed`.

- [ ] Add failing assertions that Redirect `no-change` fails semantic validation and that its machine schema decision enum is exactly `['proceed']`.
- [ ] Run `node tools/scripts/test-editorial-transform.mjs` and `node tools/scripts/test-providers.mjs`; confirm the new assertions fail because `no-change` is currently accepted.
- [ ] Change `DIAGNOSIS_DECISIONS.redirect` and the Redirect machine-schema decision enum to `proceed` only.
- [ ] Make the diagnosis prompt explicitly state that an explicit Redirect must identify the strongest evidence-supported turn-level correction and may not return `no-change`.
- [ ] Re-run both focused scripts and confirm they pass.

### Task 2: Prove Runtime Correction And Failure Semantics

**Files:**
- Modify: `tools/scripts/test-editorial-runtime.mjs`
- Modify: `src/runtime.mjs`

**Interfaces:**
- Consumes: `enhanceLatestAssistantMessage()` and the operation-scoped Editorial correction token.
- Produces: one corrected Redirect diagnosis attempt, then either one verified swipe or a red original-kept failure.

- [ ] Add a failing runtime case where the first diagnostician response is Redirect `no-change`, the correction is `proceed`, and transformation plus verification append exactly one marked swipe.
- [ ] Add a failing runtime case where both diagnoses are invalid and assert zero swipe mutation, `status: error`, and no skipped result.
- [ ] Run `node tools/scripts/test-editorial-runtime.mjs`; confirm the first case currently skips and the second does not report the required hard failure.
- [ ] Ensure invalid Redirect decisions enter the existing semantic-correction branch and that exhausted correction returns `RECURSION_EDITORIAL_DIAGNOSIS_DECISION_INVALID` as a red failure.
- [ ] Re-run the focused runtime script and confirm both cases pass.

### Task 3: Add Bounded Token-Limit Recovery

**Files:**
- Modify: `src/providers.mjs`
- Modify: `src/providers/provider-response-normalizer.mjs`
- Test: `tools/scripts/test-providers.mjs`
- Test: `tools/scripts/test-provider-response-parser.mjs`

**Interfaces:**
- Consumes: the provider router's two-attempt loop and `allowStructuredRecovery` option.
- Produces: one `token_limit_compact_retry` for machine-JSON calls, never a third call.

- [ ] Add a failing provider test where attempt one returns `finish_reason: length`, attempt two returns valid JSON, and assert two calls plus `recoverySpent: true`.
- [ ] Add a failing provider test where both attempts return `length` and assert stable token-limit failure after exactly two calls.
- [ ] Assert non-machine calls remain non-retryable on token exhaustion.
- [ ] Run the two focused provider scripts and confirm the recovery assertions fail.
- [ ] Preserve sanitized finish reason, effective max tokens, usage counts, reasoning tokens, model, and visible response size in the normalized failure details.
- [ ] Extend structured recovery eligibility to token-limit errors only for machine-JSON calls with recovery enabled, and build a compact correction prompt without changing frozen request fields or configured max tokens.
- [ ] Re-run both focused provider scripts and confirm they pass.

### Task 4: Carry Sanitized Failure Evidence Into The Journal

**Files:**
- Modify: `src/providers.mjs`
- Modify: `src/runtime.mjs`
- Test: `tools/scripts/test-runtime.mjs`
- Test: `tools/scripts/test-providers.mjs`

**Interfaces:**
- Consumes: sanitized provider diagnostics.
- Produces: explainable `provider.call.failed` records without private content.

- [ ] Add failing assertions for model, effective max tokens, finish reason, completion/reasoning usage, visible character count, retry count, and recovery kind.
- [ ] Add negative assertions excluding prompt, response text, reasoning text, credentials, and private Redirect fields.
- [ ] Run focused tests and confirm diagnostic fields are missing.
- [ ] Thread only the approved scalar diagnostics through provider failure activity and journal serialization.
- [ ] Re-run focused tests and confirm complete sanitized evidence and privacy checks pass.

### Task 5: Update Documentation And Live Proof

**Files:**
- Modify: `docs/superpowers/specs/2026-07-15-recursion-redirect-improvement-design.md`
- Modify: `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`
- Modify: `docs/testing/TESTING_STRATEGY.md`
- Modify: `tests/evaluation/scenarios/core/redirect-turn-deferral.json`
- Modify: `tools/scripts/prove-live-enhancements.mjs`
- Modify: `tools/scripts/lib/live-editorial-effectiveness.mjs`
- Test: `tools/scripts/test-live-harness.mjs`
- Test: `tools/scripts/test-model-eval-harness.mjs`

**Interfaces:**
- Consumes: shared live Enhancement oracle and the core Redirect corpus.
- Produces: a live turn-deferral proof that cannot pass on skipped or unhealthy outcomes.

- [ ] Update docs to remove Redirect `no-change` and describe bounded token recovery.
- [ ] Strengthen the SG-1-like turn-deferral scenario so its source repeats an answered question, elaborates away from the requested test, and postpones action outside.
- [ ] Add failing harness assertions that Redirect skipped/no-change is always unhealthy, including scenarios formerly marked expected no-change.
- [ ] Update the live runner and corpus contract so every explicit Redirect scenario expects `proceed` and exactly one verified swipe.
- [ ] Run `node tools/scripts/test-live-harness.mjs` and `node tools/scripts/test-model-eval-harness.mjs`; confirm they pass after the contract update.

### Task 6: Verification And Live Playwright Proof

**Files:**
- Verify only; no production edits unless a failing test identifies a contract defect.

**Interfaces:**
- Consumes: completed implementation and a configured `recursion-soak-*` SillyTavern user.
- Produces: deterministic and visual evidence of a healthy Redirect.

- [ ] Run `npm.cmd test` and require exit code 0 with no suite failures.
- [ ] Run `npm.cmd run check:playwright` and `npm.cmd run check:soak-users`.
- [ ] Deploy the repository extension to a dedicated soak user while excluding `.git`, `node_modules`, artifacts, temporary files, tests, and remote attachments.
- [ ] Run `npm.cmd run prove:enhancements-live` with the SG-1-like turn-deferral case and configured real model calls.
- [ ] Inspect desktop and phone screenshots: all observed progress rows must be green/done, the final Redirect must add exactly one swipe, and no stale or pre-generation rows may appear.
- [ ] Review `git diff --check`, `git status --short`, and the final diff for unrelated changes.

