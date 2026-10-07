# Recovery and Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover validated work from malformed model output and deliver a single understandable card-target/settings contract.

**Architecture:** Keep the durable scheduler, canonical provider router, existing family stages, and three-tab native UI. Introduce bounded structural checks and correction feedback, preserve accepted Fused siblings, distinguish mandatory coverage from optional enrichment, and replace persisted Min/Max counts with one independent target.

**Tech Stack:** Browser ES modules and Node.js scripts, existing vendored jsonrepair, Playwright dev dependency, no new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-10-07-recovery-and-settings-design.md`

## Global Constraints

- Design, plan, and execution were preapproved on 2026-10-07; do not stop for review/approval prompts.
- In-place V1 contract; no old min/max conversion, duplicate persistence, or compatibility aliases.
- `cardsPerTurn`: integer 0..20, default 6; derived budget policy `{targetCards}`.
- Mandatory cards may exceed target. Zero schedules no discretionary cards.
- Structural processing limits: 262,144 characters, depth 64, 40 complete bundle items; 8 field issues, paths capped at 160 characters.
- Current defaults: two model attempts, request 180 seconds, operation 300 seconds.
- Preserve source-bound checkpoints, underlying transport queue ownership, cancellation, budget reservation, required coverage, and secret redaction.
- Keep graphite, compact SillyTavern-native Play / Providers / Advanced; use visible helper copy and field-local provider autosave.
- No live account edits, provider-spend benchmark, deployment, merge, push, or publish in this request.

## Review Focus

1. Escaped equivalent duplicate keys and braces inside strings: no silent value substitution or false fragment boundary.
2. Mixed bundle output beyond the old 12,000-character cap: preserve every bounded complete valid sibling, never complete the unfinished item.
3. Message-array requests, wrapped stage requests, and explicit Native Schema: corrections reach the actual host payload and explicit policy is honored.
4. Manual target zero, repeated family sources, and mandatory overflow: one per-turn projection owns scheduling and prompt inclusion without modifying deck state.
5. Reload/Stop/source changes while recovery and optional omissions occur: no extra dispatch, stale prompt installation, or recovered warning left after complete success.

## File and responsibility map

| Unit | Files | Owns |
| --- | --- | --- |
| Structural parsing | `src/providers/structured-output-parser.mjs`, new `src/providers/output-contract.mjs` | Bounded scanning, ambiguity, schema issues |
| Provider boundary | `src/providers.mjs`, `src/providers/provider-response-normalizer.mjs`, `src/failures.mjs` | Transient fragment handoff, shared card contracts, sanitized issues |
| Retry feedback | new `src/execution/correction-request.mjs`, `src/execution/attempt-policy.mjs` | Initial-request correction, policy-aware directives, jitter |
| Durable recovery | `src/runtime.mjs`, `src/runtime/preprocess-graph.mjs`, `src/cards.mjs`, `src/fused-recovery.mjs` | Fragment acceptance, individual fallback, mandatory/optional coverage |
| Card settings | `src/settings.mjs`, `src/settings-policy.mjs`, `src/card-scope.mjs`, `src/pre-process-decks.mjs`, runtime count sections | One target and Manual projection |
| UI | `src/ui.mjs`, `src/ui/provider-panel.mjs`, `styles/recursion.css` if needed | Plain settings, disclosure state, routing and check details |
| Qualification | `src/provider-capability.mjs`, `src/providers/generation-policy.mjs`, `src/providers/profile-certification.mjs`, settings certification fields | Config + actual profile identity truth |
| Evidence | focused scripts and fixtures, existing docs and schemas, new results document | Behavioral proofs and current contracts |

Tasks 1 and 5 have independent contracts and may be implemented in parallel. Runtime edits must be coordinated by section; never overwrite another worker's changes. Task 2 depends on Task 1. Task 3 integrates helpers into Task 2's stage calls after their shared interfaces exist. UI Task 6 consumes Task 5. Qualification Task 4 consumes provider request metadata from Task 3. Final review/tests run on the integrated branch.

## Task 1: Bounded parsing and canonical field issues

**Files:** Modify `src/providers/structured-output-parser.mjs`, `src/providers.mjs`, `src/failures.mjs`; create `src/providers/output-contract.mjs`; update `tools/scripts/test-provider-response-parser.mjs`, `test-card-payload-normalization.mjs`, and new `test-output-contract.mjs`.

**Interfaces:**
- `validateOutputShape(value, schema, {maxIssues=8}={}) -> {ok,issues}`.
- `parseStructuredJsonText(text, options)`: keep current result shape, add `json_ambiguous`/bounded-limit codes.
- `extractJsonObjectsFromArrayProperty(text, propertyName='items')`: same array return, enforce limits and string-aware actual array-member scanning.
- Provider failures may carry sanitized `fieldIssues` and transient `recoverableItems`; journals must never persist the latter.

- [ ] Write one duplicate-key regression, run RED, implement same-object key detection, run GREEN. Then repeat for escaped keys and competing roots.

```js
const parsed = parseStructuredJsonText('{"promptText":"first","promptText":"second"}');
assert.equal(parsed.ok, false);
assert.equal(parsed.diagnostic.code, 'json_ambiguous');
```

- [ ] Add one scanner-boundary case at a time: quoted braces, nested objects with legal same-name keys, singleton array normalization, depth/size overflow, complete items before unfinished tail. Run `node tools/scripts/test-provider-response-parser.mjs` after each change; expected RED then PASS.
- [ ] Write shape-validation regressions; implement the exact emitted JSON-schema subset and reject unsupported constructs during tests.

```js
const result = validateOutputShape({promptText:'Keep the door closed.', evidenceRefs:27}, cardSchema);
assert.equal(result.ok, false);
assert.deepEqual(result.issues.map(({path,rule}) => ({path,rule})), [{path:'evidenceRefs',rule:'type'}]);
assert.ok(!JSON.stringify(result).includes('MODEL_PRIVATE_TEXT'));
```

- [ ] Derive card item checks from `jsonSchemaForRequest`, retaining per-item Fused isolation and deterministic normalization. Validate wire payload separately from trusted Post-process envelope identities. Carry up to eight issues through sanitized errors. Run relevant router/payload/Guidance/refinement scripts; expected PASS with intentionally updated contract fixtures.
- [ ] Extract up to 40 complete eligible Fused items before diagnostic truncation. Preserve token-limit visible content in memory before throwing; never capture refusal content for salvage. Test actual router with a partial long response and negative auth/refusal cases.
- [ ] Commit the independently testable parser/provider change after GREEN and record RED/GREEN commands in the ledger.

## Task 2: Durable salvage, strict evidence, and required coverage

**Files:** Modify `src/runtime.mjs` recovery/deck/hand sections only, `src/runtime/preprocess-graph.mjs`, `src/cards.mjs`, `src/fused-recovery.mjs`; update `test-fused-recovery.mjs`, `test-pipeline-fused.mjs`, `test-card-plan-coverage.mjs`, `test-card-budget-parity.mjs`, `test-runtime.mjs`, and focused recovery integration fixtures.

**Interfaces:** Consume `recoverableItems` and `fieldIssues` from Task 1. Add one recovery allowlist helper and one required-job predicate reused by stage construction and hand validation. Durable artifact keeps `{cards,outcomes,acceptedFamilies,unresolvedFamilies,rejections,fallback}` with fixed-code recovery/omission summaries.

- [ ] Add the reproduced durable-boundary regression; observe RED before implementing salvage.

```js
const result = validateFusedProviderResult({
  ok:false, error:{code:'RECURSION_JSON_PARSE_FAILED',category:'validation'},
  recoverableItems:[{family:'Scene Frame',promptText:'Keep the doorway in view.',evidenceRefs:['message:8']}]
}, {selectedCards,request,cardContext:{firstMesId:8,lastMesId:8}});
assert.deepEqual(result.value.acceptedFamilies, ['Scene Frame']);
assert.deepEqual(result.value.fallback.families, ['Character Motivation']);
```

- [ ] Allow eligible output failures into identical item validation; preserve original safe cause separately. Add negative cases for refusal, auth, canceled, rate-limit, stale and exhausted-operation results even if they include apparently valid items. Run Fused suites; expected PASS.
- [ ] Add strict-reference regression; remove latest-message substitution and partial dropping. Run affected card/payload/refinement suites with current-contract fixture changes.

```js
assert.deepEqual(cardsFromProviderResult({ok:true,data:{promptText:'Keep the doorway in view.',evidenceRefs:['message:42']}},
  {...sourceContext,firstMesId:8,lastMesId:8}), []);
```

- [ ] For eligible Fused token/context exhaustion with no usable item, settle into individual-family fallback without fabricating a semantic rejection. Accepted siblings must not dispatch again. Test a real scheduler/router chain with synthetic transport; expected mandatory-first budget reservation and exact selected lane.
- [ ] Restore `continue` for optional generated enrichment; retain blocking for selected Scene Constraints and forced coverage. Filter the hand's required generated requirements using the same predicate; retain all selected authored coverage. Explain omitted optional work in hand summary/diagnostics and amber aggregate progress.
- [ ] Add one end-to-end optional-failure regression, then mandatory negative control: optional failure installs a smaller valid packet; mandatory failure performs no install and exposes Retry. Add Stop/reload/source-change cases that prove no late commit or fresh extra budget. Expected PASS in focused runtime/Fused/progress suites.
- [ ] Commit and ledger the independently testable durable change.

## Task 3: Meaningful corrections and cause-specific retries

**Files:** Create `src/execution/correction-request.mjs`; modify `src/execution/attempt-policy.mjs`, `src/providers/rate-limit-policy.mjs`, durable correction call sites in `runtime.mjs`, `runtime/preprocess-graph.mjs`, `post-process-runtime.mjs`, and request configuration in `createDurableExecutionGraph`; update attempt/operation-budget/Post-process tests.

**Interfaces:**
- `buildStructuredCorrectionRequest({originalRequest,currentRequest=originalRequest,failure={},attempt=1,taskFeedback=''}) -> request`.
- `runModelStageAttempts` passes initial request, current request, and sanitized failure/field issues to correction builders; no unchanged corrected dispatch.
- Retry resolver unwraps `{roleId,request}` and consults explicit configured structured-output policy. Jitter accepts injected random function for deterministic tests.

- [ ] Write RED for two corrections accumulating prompt text; implement rebuilding from original request and preserving current responseLength/format adjustments. Add message-array correction regression.

```js
const first = buildStructuredCorrectionRequest({originalRequest:{prompt:'SOURCE'},failure:{fieldIssues:[issue]}});
const second = buildStructuredCorrectionRequest({originalRequest:{prompt:'SOURCE'},currentRequest:first,failure:{fieldIssues:[issue]},attempt:2});
assert.equal(second.prompt.split('SOURCE').length, 2);
assert.equal(second.prompt.split('Correction required.').length, 2);
```

- [ ] Wire helpers into canonical durable Arbiter/cards/Fused/Guidance and Post-process guidance, retaining role-specific instructions. Ensure thrown validation errors preserve field issues and corrections reach actual message-based transport. Expected PASS in attempt, runtime and Post-process suites.
- [ ] Add forced-native negative control and Auto downgrade test for both wrapped/direct request shapes. Materialize configured generation policy and effective method on durable requests and safe failure metadata; forced native stops, Auto changes the nested actual request.
- [ ] Test context reservation reduction at floor and Fused individual fallback from Task 2; no arbitrary source-text truncation. Test token expansion respects configured ceiling. Add bounded jitter preserving minimum Retry-After and immediate Stop during cooldown.
- [ ] Commit and ledger commands/results.

## Task 4: Qualification tied to the actual profile

**Files:** Modify `src/provider-capability.mjs`, `src/providers/profile-certification.mjs`, `src/providers/generation-policy.mjs`, `src/settings.mjs` certification normalization/store, and provider client metadata; update provider-capability, generation-policy, provider-settings/transport tests.

**Interfaces:** `providerProfileIdentityHash(profile) -> string`; certification stores `profileIdentityHash` alongside configHash. Capability receives live safe host descriptors; generation policy receives explicitly validated certification state rather than trusting a stale saved native marker.

- [ ] Write RED for same profile ID with changed model; implement identity hash from model/API/completion/preset/instruct descriptors and compare at capability resolution.

```js
const capability = resolveProviderCapability({settings:certifiedSettings,
  host:{connectionProfiles:[{...testedProfile,model:'different-model'}]}});
assert.equal(capability.state, 'uncertified');
```

- [ ] Add stale config hash + native marker regression: Auto emits Prompt JSON, while explicit Native remains explicit. Certification records the fingerprint exercised and is discarded on profile edits/revision mismatch. Tests must prove no hidden generation probe.
- [ ] Preserve conservative same-profile concurrency and partial single-card qualification. Run focused provider suites; expected PASS. Commit and ledger.

## Task 5: Independent card target and correct Manual projection

**Files:** Modify `settings.mjs`, `settings-policy.mjs`, `card-scope.mjs`, `pre-process-decks.mjs`, count/settings-signature sections of `runtime.mjs`, count-policy sections of `cards.mjs`, `runtime/diagnostics.mjs`; update settings/count/selection/Manual fixtures and related tests. Do not modify recovery sections concurrently owned by Task 2.

**Interfaces:** persisted `{cardsPerTurn:6}`; `normalizeCardBudgetSettings(value) -> {targetCards}`; pure Manual per-turn deck selection returns selected authored IDs, selected generated families/source IDs, mandatory IDs, and omitted units. Internal `plan.budgets.maxCards` remains.

- [ ] Write normalization RED: clamp 0..20, preserve zero, default6, drop minCards/maxCards. Replace defaults, normalizer, paired patch reconciliation, reset keys, diagnostics and signatures.
- [ ] Write all-level/cross-pipeline target RED, remove Low/average/Ultra count ownership. Keep routing independent and mandatory overflow.

```js
for (const reasoningLevel of ['low','medium','high','ultra']) {
  const plan = localFallbackPlan(snapshot,{cardsPerTurn:4,reasoningLevel});
  assert.equal(plan.budgets.maxCards, 4);
}
```

- [ ] Implement Manual projection with mandatory Refinement units first, then deck-ordered ordinary units. Authored cards count individually; generated family sources share one unit. Use the projection for provider scope, jobs, authored inclusion, and forced requirements. Lowering target never changes saved card states.
- [ ] Add Manual zero, repeated-family source, mandatory-overflow, and lowering-target tests; verify the actual installed hand, not only helper output. Run settings/selection/budget/runtime/refinement focused suites; expected PASS.
- [ ] Update settings literals in test/live harness fixtures where they describe operator settings; preserve internal model plan maxCards. Record intentional old-contract changes. Commit and ledger.

## Task 6: Clear settings and preserved disclosures

**Files:** Modify `src/ui.mjs`, `src/ui/provider-panel.mjs`, existing CSS only if geometry requires it; update rendered DOM/autosave tests and synthetic browser proof.

**Interfaces:** Consume `cardsPerTurn` and live capability/check information. Preserve existing lane fields/selectors, field-local configRevision commits, and session-local disclosure state.

- [ ] Write a rendered settings regression then replace Min/Max rows with Cards per turn and rename Strength/Footprint labels to Guidance strength/Guidance detail. Show concise helper and computed target/routing summary.
- [ ] Update reasoning-chain descriptions to describe provider routing without count promises. Readsettings patch and card-view keys persist only new target; ensure hidden mounted controls do not reset unrelated fields.
- [ ] Write disclosure persistence RED; move provider policy fields under collapsed Compatibility and tuning while profile/test/checks remain visible. Preserve nested and Advanced disclosure state across autosave/tab changes. Show single/combined card check and effective output/concurrency details without raw profile IDs.
- [ ] Add visible attempts-budget helper: initial call included, separately bounded capacity retries, operation allowance, Resume versus Retry semantics. Verify touch/tooltips-off discoverability through visible text and keyboard disclosure behavior.
- [ ] Run `node tools/scripts/test-ui.mjs`, provider-panel and synthetic browser proof; expected PASS. Inspect desktop/mobile screenshots. Commit and ledger.

## Task 7: Current documentation, diagnostics, and failure corpus

**Files:** Update DESIGN.md, UI_SPEC, BEHAVIOR_SETTINGS_POLICY_SPEC, card/turn/provider/diagnostics current-contract docs, schema/example files where relevant; add `docs/verification/2026-10-07-recovery-and-settings.md` and bounded synthetic corpus under tests.

**Interfaces:** One documentation vocabulary, one current target contract, one recovery summary derived from real stage records. Historical dated specs are historical evidence and need not be rewritten as current implementation docs.

- [ ] Derive bounded recovery metrics from actual attempts/outcomes; add a behavior test proving accepted salvage and optional omissions survive diagnostics export while raw rejected content does not.
- [ ] Add synthetic corpus cases for syntax repair, competing roots/keys, long/partial bundles, invalid evidence, capacity/refusal, and Stop/reload. Reuse canonical entry points; no alternate parser in tests and no assertion solely on source text.
- [ ] Update authority docs and examples together; reconcile existing contradictory Fused certification-gate copy with explicit-request/runtime-recovery behavior. Record implemented boundaries and excluded live benchmarking/deployment accurately.
- [ ] Commit docs/results after reviewing for contradictions, missing requirements, and misleading success labels.

## Task 8: Integration gates and independent review

**Files:** Whole branch plus execution ledger and final results document.

- [ ] Run changed-module syntax checks and all changed focused suites, inspect exit codes and output. Redirect long gate output to this plan's ignored workspace and retain failure names.
- [ ] Run full `npm.cmd test` with permission for local child Node processes. Expected all offline scripts PASS; browser-dependent scripts are explicitly separate.
- [ ] Install locked dev dependencies only if needed; run `npm.cmd run test:alpha` and relevant `npm.cmd run test:browser`/synthetic UI proof. Expected PASS; any environmental limitation is recorded separately and resolved when possible.
- [ ] Request an independent fresh-context full-branch review against spec/plan. Fix Critical/Important findings with one RED/GREEN regression each; rerun gates only for new changes or unresolved failures.
- [ ] Review `git diff --check`, production/version/docs coherence, actual branch/artifact state. Commit final changes and update results/ledger with exact commands and reviewer disposition.
- [ ] Mark the goal complete only when all scoped implementation and required verification are finished. Deliver spec, plan, branch, tests and remaining live-benchmark limitation. Preserve the worktree for review; no publish/merge/deploy.
