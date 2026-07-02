# Reasoning Amount Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Recursion Reasoning Level control provider-level reasoning amount across direct OpenAI-compatible endpoints and SillyTavern host routes, then prove it with automated and live Playwright verification.

**Architecture:** Runtime and prompt composition add a normalized `reasoningIntent` to provider requests. Provider adapters translate that intent into safe provider-specific request fields and sanitized diagnostics. Host adapters pass the same normalized intent through SillyTavern generation seams without exposing raw reasoning.

**Tech Stack:** JavaScript ES modules, PowerShell, SillyTavern host adapter, Node test scripts, Playwright live smoke tooling.

---

## File Structure

- `src/providers.mjs`: add `normalizeReasoningIntent`, `reasoningIntentForRequest`, `reasoningDialectForOpenAiCompatible`, `applyOpenAiCompatibleReasoning`, and retry downgrade behavior.
- `src/runtime.mjs`: annotate Reasoner Arbiter and Reasoner card calls with `reasoningCategory`.
- `src/prompt.mjs`: annotate `reasonerComposer` with final-brief reasoning category.
- `src/hosts/sillytavern/host.mjs`: pass reasoning metadata into `generateRaw` and `ConnectionManagerRequestService.sendRequest`.
- `tools/scripts/test-providers.mjs`: red-green tests for direct endpoint body shape and diagnostics.
- `tools/scripts/test-runtime.mjs`: red-green tests for role/category mapping.
- `tools/scripts/test-host.mjs`: red-green tests for SillyTavern host pass-through.
- `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`, `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md`, and user provider docs: document the contract.

### Task 1: Provider Intent Contract

**Files:**
- Modify: `tools/scripts/test-providers.mjs`
- Modify: `src/providers.mjs`

- [ ] **Step 1: Write failing tests**

Add tests that call `createGenerationRouter(...).generate(...)` through direct OpenAI-compatible providers with models/base URLs that resolve to OpenRouter/OpenAI, Z.AI GLM, MiniMax-M3, DeepSeek, and unknown endpoints. Assert request body reasoning fields match the design matrix and unknown endpoints omit speculative fields.

- [ ] **Step 2: Verify red**

Run:

```powershell
npm.cmd run test:providers
```

Expected: new reasoning-body assertions fail because no request carries `reasoning`, `thinking`, `reasoning_effort`, or sanitized reasoning diagnostics yet.

- [ ] **Step 3: Implement minimal provider helpers**

Add normalized intent values `minimal | medium | high`, map them to provider dialects, and enrich diagnostics without logging raw prompts or raw provider reasoning.

- [ ] **Step 4: Verify green**

Run:

```powershell
npm.cmd run test:providers
```

Expected: provider tests pass.

### Task 2: Runtime And Prompt Categories

**Files:**
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `src/runtime.mjs`
- Modify: `src/prompt.mjs`

- [ ] **Step 1: Write failing tests**

Assert Medium and High `reasonerComposer` requests carry `reasoningCategory: "final-brief"` and `reasoningIntent: "medium"`, Ultra final brief carries `high`, High Reasoner Arbiter carries `medium`, and High Reasoner card calls stay `minimal`.

- [ ] **Step 2: Verify red**

Run:

```powershell
npm.cmd run test:runtime
```

Expected: assertions fail because calls do not include reasoning category or intent.

- [ ] **Step 3: Implement request annotations**

Add a small runtime helper that maps `settings.reasoningLevel` plus call category to `reasoningIntent`, and pass it into Arbiter, card, and reasoner composer requests.

- [ ] **Step 4: Verify green**

Run:

```powershell
npm.cmd run test:runtime
```

Expected: runtime tests pass.

### Task 3: SillyTavern Host Pass-Through

**Files:**
- Modify: `tools/scripts/test-host.mjs`
- Modify: `src/hosts/sillytavern/host.mjs`

- [ ] **Step 1: Write failing tests**

Assert `generateRaw` receives `reasoningIntent` and connection-profile `sendRequest` receives a sanitized reasoning parameter when a provider request includes `reasoningIntent`.

- [ ] **Step 2: Verify red**

Run:

```powershell
npm.cmd run test:host
```

Expected: host pass-through assertions fail.

- [ ] **Step 3: Implement pass-through**

Forward normalized reasoning metadata only, not raw reasoning content. Keep existing machine-JSON schema behavior intact.

- [ ] **Step 4: Verify green**

Run:

```powershell
npm.cmd run test:host
```

Expected: host tests pass.

### Task 4: Docs And Full Verification

**Files:**
- Modify: provider and user docs listed above.

- [ ] **Step 1: Update docs**

Document the intent matrix, provider dialect behavior, unknown-provider downgrade behavior, and privacy boundary.

- [ ] **Step 2: Run focused tests**

Run:

```powershell
npm.cmd run test:providers
npm.cmd run test:host
npm.cmd run test:runtime
```

Expected: all focused tests pass.

- [ ] **Step 3: Run full test suite**

Run:

```powershell
npm.cmd test
```

Expected: full suite passes.

### Task 5: Live SillyTavern Playwright Proof

**Files:**
- May use existing live harness and `.recursion-doc-renderer` proof artifacts.

- [ ] **Step 1: Confirm live readiness**

Run the existing Playwright readiness and soak-user checks.

- [ ] **Step 2: Sync installed extension copy if needed**

If SillyTavern serves an installed extension copy rather than the checkout, copy only the touched implementation files and confirm hashes.

- [ ] **Step 3: Run live Playwright proof**

Use a dedicated `recursion-soak-*` user. Exercise Reasoning Level High or Ultra with a configured Reasoner route and inspect sanitized request evidence that final brief/pre-conditioning used the stronger reasoning intent.

- [ ] **Step 4: Completion audit**

Verify every requirement in `docs/superpowers/specs/2026-07-02-reasoning-amount-routing-design.md` has direct evidence from code, tests, docs, or live behavior.
