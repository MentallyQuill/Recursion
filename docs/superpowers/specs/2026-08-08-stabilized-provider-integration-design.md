# Stabilized Provider Integration Design

**Status:** Approved for execution by the repository owner on 2026-08-08.

**Source artifact:** `Recursion-0.2.0-alpha.2-stabilized.zip` (`SHA-256 B83D3171EC84574429C63EB083442263DE6BEC192D5D1FA5C3DA2BDA7FD3E4E6`)

**Target:** `refactor` at `b4256f203dacd23c69707a6b26c640ed10046659`.

## Goal

Integrate the candidate's coherent V1 Connection Profile provider architecture and pipeline robustness work without importing its unverified claims or the regressions found during audit. The result must remain SillyTavern-native, pre-alpha-clean, releasable as `0.2.0-alpha.2`, and demonstrably identical across source, installed, and public extension copies.

## Considered approaches

1. **Selective transplant plus repair (chosen).** Use the candidate as a donor, exclude generated/vendor material and superseded review artifacts, then repair the audited contract failures under test before accepting the integration. This preserves the valuable cross-cutting work while keeping the target branch authoritative.
2. **Blind overlay then patch.** Faster initially, but it would import `node_modules`, misleading stabilization claims, stale release metadata, and weak gates. The audit proved that a green suite alone would not make this safe.
3. **Reimplement every change from the baseline.** Lowest provenance risk but needlessly discards a large amount of working, tested architecture and would create a second independent implementation of the same contracts.

## Product and visual contract

This integration changes provider configuration and status surfaces, not Recursion's visual identity. The UI remains compact graphite SillyTavern chrome governed by `DESIGN.md` and `docs/design/UI_SPEC.md`.

- Provider configuration is Connection Profile-only. Direct endpoint, API-key, and provider-specific secret fields are not part of the V1 UI or stored settings contract.
- Provider lanes expose compact derived states: `Ready`, `Untested`, `Unhealthy`, or `Configure`. They do not gain a separate enable switch.
- Generation policy and per-profile sampler settings remain separate controls.
- Segmented and Fused capability/certification state is disclosed operationally; it must not become a dashboard or a provider marketing surface.
- Existing spacing, typography, state colors, keyboard access, and ARIA requirements remain authoritative.

## Architecture

### 1. Candidate intake boundary

The candidate is a read-only donor. Only project-owned source, tests, tools, styles, package metadata, and normative documentation may be transplanted. Exclude `node_modules`, nested baseline archives/directories, transient outputs, and the candidate's `docs/reviews/2026-08-07-stabilization-pass.md` and superseded implementation plan. The committed design and plan in this change become the decision record.

### 2. Provider transport contract

All model calls flow through SillyTavern's `ConnectionManagerRequestService.sendRequest(profileId, request, maxTokens, custom)` surface. Each profile owns a FIFO request queue with abort-aware settlement. Stage output budgets clamp every call. Provider/model generation policy remains independent from sampling parameters.

Structured responses normalize into one internal envelope. The normalizer must accept OpenAI-compatible response shapes and SillyTavern's Claude tool-call representation, including `content[].input`. A schema-capable Claude response must never normalize to an empty success.

### 3. Batch settlement contract

Segmented batches settle per slot. A thrown or rejected request becomes a failure result for that slot; it does not reject the batch or erase successful siblings. Ordering remains identical to request ordering. Abort remains an intentional operation-level cancellation rather than a fabricated slot result.

### 4. Fused failure contract

Fused keeps valid sibling cards and may fall back to Segmented when the bundle yields no useful card. Provider failures retain their original stable identity through the Fused boundary. Context-limit, structured-output-unsupported, rate-limit, transient, abort, and configuration failures must reach the execution attempt policy unchanged; `RECURSION_FUSED_ZERO_USEFUL_CARDS` is reserved for a successful provider response whose parsed bundle contains zero useful cards.

### 5. Capability and certification contract

Certification records real profile behavior for plain generation, structured generation, Segmented, and Fused support. Unsupported structured output may cause the documented downgrade. Empty or malformed responses are failures, not evidence of unsupported schema. Default/auto selection uses only current, healthy certification evidence.

### 6. Release truth

`package.json`, `manifest.json`, storage/runtime version constants, release notes, documentation index, README, normative provider docs, tests, and examples must agree on `0.2.0-alpha.2` and the Connection Profile-only contract. The alpha gate must fail on version drift, normative direct-key guidance, missing Claude tool-input coverage, or missing per-slot batch isolation coverage.

## Data flow

```text
Recursion stage request
  -> resolve Connection Profile and stage budget
  -> enqueue on that profile's FIFO
  -> SillyTavern ConnectionManagerRequestService
  -> normalize text or structured envelope
  -> settle one request result
  -> Segmented: preserve each slot independently
     Fused: validate each item, retain valid siblings, preserve provider failure identity
  -> execution attempt policy decides retry, downgrade, fallback, or stop
  -> sanitized progress, diagnostics, and prompt packet
```

## Error handling

- Stable provider codes and retry directives are the authority across transport, pipeline, progress, and diagnostics.
- Raw provider bodies, secrets, hidden reasoning, and stack traces do not enter normal UI or persisted prompt packets.
- Batch siblings remain observable even when one request fails.
- Fused fallback records its transition without replacing the triggering provider code.
- Installed-copy mismatch is a release blocker, not a warning.

## Verification contract

1. Focused regression tests demonstrate RED before production repair and GREEN after it for Claude `content[].input`, mixed-success batches, Fused provider-code preservation, and release/gate drift.
2. Every production module passes syntax/import checks.
3. `npm test` passes in the final source tree.
4. `npm run test:alpha` passes and explicitly covers the new release-truth assertions.
5. After commit, only production files are synchronized to `F:\SillyTavern\SillyTavern\data\default-user\extensions\Recursion-refactor` and its public served copy; user data is untouched.
6. The installed-copy verifier proves source, installed, and public parity.
7. Browser/live smoke proves SillyTavern serves and loads `Recursion-refactor`; provider-spend proofs are run only when an already configured profile makes them deterministic and safe.

## Merge decision

The integration may commit and push directly to `refactor` only when every deterministic release gate is green and the independent review finds no release blocker. No compatibility shim for the replaced direct-provider settings is permitted because Recursion is pre-alpha.
