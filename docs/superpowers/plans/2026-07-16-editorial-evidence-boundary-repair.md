# Editorial Evidence Boundary Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure Redirect receives the actual latest user turn and generated Recursion cards, and prevent verifier schema deadlock from producing whitespace until the token limit.

**Architecture:** Build Editorial evidence from bounded structured fields before public snapshot serialization. Keep generated hand cards authoritative, carry the same frozen evidence through Diagnosis, Transform, and Verification, and spell out all eight verifier checks in the provider prompt while retaining semantic validation.

**Tech Stack:** JavaScript ES modules, Node.js test scripts, SillyTavern host adapter, Playwright live proof.

## Global Constraints

- Redirect semantic validation remains authoritative.
- Private evidence and diagnosis data must not enter visible prose or UI.
- Live proof must use a `recursion-soak-*` user; deployment to `default-user` happens only after tests pass.
- Existing prompt-neutral Enhancement and same-turn swipe reuse behavior must remain intact.

---

### Task 1: Structured Editorial Evidence

**Files:**
- Modify: `tools/scripts/test-editorial-transform.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `src/editorial-transform.mjs`
- Modify: `src/runtime.mjs`
- Modify: `src/generation-review.mjs`

**Interfaces:**
- Consumes: latest bounded context messages, `lastHand.cards`, and `lastPacket`.
- Produces: a bounded structured snapshot whose `context.messages` and `installedHand` remain parseable and whose installed hand contains generated card content.

- [ ] Add a regression with a long SG-1-shaped context and generated cards whose source cards contain generic template text.
- [ ] Run `npm.cmd run test:runtime` and `node tools/scripts/test-editorial-transform.mjs`; confirm the new assertions fail because the user turn disappears and template text wins.
- [ ] Preserve bounded context as structured data and map generated hand cards directly into the Editorial installed hand.
- [ ] Run the focused tests and confirm the actual user turn and generated card guidance are frozen as evidence while generic source templates are absent.

### Task 2: Verifier Coverage Contract

**Files:**
- Modify: `tools/scripts/test-editorial-transform.mjs`
- Modify: `tools/scripts/test-providers.mjs`
- Modify: `src/editorial-transform.mjs`
- Modify: `src/providers.mjs`

**Interfaces:**
- Consumes: `REDIRECT_VERIFICATION_CHECKS`.
- Produces: a verifier prompt and machine schema that require one result for each named check.

- [ ] Add assertions that the verifier prompt lists all eight check names in canonical order and requests exactly one result per check.
- [ ] Run focused tests and confirm the prompt assertions fail.
- [ ] Generate verifier instructions from `REDIRECT_VERIFICATION_CHECKS` and keep the eight-item semantic validator unchanged.
- [ ] Run focused tests and confirm all verifier contract assertions pass.

### Task 3: Verification And Deployment

**Files:**
- Modify if required by contract changes: `docs/testing/TESTING_STRATEGY.md`
- Deploy: SillyTavern public Recursion extension and `data/default-user/extensions/Recursion`

**Interfaces:**
- Consumes: repaired repository files.
- Produces: matching deployed copies and live proof artifacts.

- [ ] Run `npm.cmd test` and require every suite to pass.
- [ ] Sync the repository extension to the SillyTavern served and `default-user` extension locations.
- [ ] Compare hashes for every changed runtime file.
- [ ] Start SillyTavern and run the dedicated Enhancement Playwright proof against a `recursion-soak-*` account.
- [ ] Require the strict live oracle, a validated Recursion-owned result, and healthy terminal progress rows.
