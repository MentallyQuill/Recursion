# Provider JSON Robustness Pass

## Purpose

This pass reviews Directive's provider response parsing approach and defines the Recursion work needed to reach the same practical robustness while preserving Recursion's stricter V1 machine-output contract.

The immediate live failure that motivated this pass was not malformed JSON syntax. The provider returned valid visible JSON, but omitted the required Recursion envelope fields. That was addressed separately by tightening machine-JSON prompts, schema metadata, and snapshot-hash constraints. This document covers the next layer: malformed-but-recoverable provider output after the response is received.

Recursion is pre-alpha. There is no need to preserve the current thin parser as a compatibility layer. When this pass is implemented, update code, tests, docs, and diagnostics in place to the best V1 contract.

## Implementation Status

Implemented in the V1 provider path:

- `src/providers/structured-output-parser.mjs` owns wrapper stripping, safe syntax repair, object extraction, and bounded parse diagnostics.
- `src/providers/provider-response-normalizer.mjs` owns provider-envelope visible-text extraction, reasoning-only detection, token-limit classification, response description, and shared provider-response errors.
- `src/providers.mjs` consumes the shared parser/normalizer, records compact repair metadata, keeps schema mismatch correction retries, and keeps raw malformed provider text out of success diagnostics.
- `tools/scripts/test-provider-response-parser.mjs`, `tools/scripts/test-providers.mjs`, and `tools/scripts/test-runtime.mjs` cover syntax repair, provider-router integration, stable failures, sanitized diagnostics, and the runtime semantic boundary.

The old “Recursion Current State” section below is retained as the review baseline that motivated the pass, not as the current implementation description.

## Executive Summary

Directive is more robust than Recursion today.

Recursion currently does three useful things:

- extracts fenced JSON and the first balanced object from wrapper prose in `src/core.mjs`;
- classifies token-limit, empty visible output, and reasoning-only output in `src/providers.mjs`;
- validates provider role schema and, for snapshot-bound roles, lets runtime reject missing or mismatched `snapshotHash`.

Directive adds a stronger middle layer:

- response normalization is centralized in `src/providers/provider-response-normalizer.mjs`;
- structured JSON recovery is centralized in `src/providers/structured-output-parser.mjs`;
- repair attempts are explicit, ordered, tested, and reported as repaired;
- callers consume shared parser/normalizer behavior instead of writing one-off extraction logic.

Recursion should adopt Directive's architecture, not copy every Directive-specific repair rule verbatim. The shared response normalizer and general JSON repair pipeline should be ported. Directive's operation-array closer repair should be treated as a pattern to adapt only if Recursion has a recurring schema-specific malformed shape.

## Directive Approach Review

### Provider Response Normalizer

Directive's `src/providers/provider-response-normalizer.mjs` separates provider-envelope extraction from structured JSON parsing.

Key behaviors:

- `extractProviderResponseText(...)` reads visible text from common provider shapes:
  - raw strings;
  - OpenAI-style `choices[0].message.content`;
  - streamed-ish `choices[0].delta.content`;
  - candidate/output arrays;
  - nested content arrays with `text`, `content`, or `value`;
  - direct `message.content`, `content`, `response`, or `text`;
  - object-shaped provider returns that already look like structured response data.
- `extractProviderResponseReasoning(...)` separately extracts hidden or reasoning-only fields:
  - `reasoning`;
  - `reasoning_content`;
  - `reasoningContent`;
  - `reasoning_details`;
  - `reasoningDetails`.
- `collectProviderResponseFinishReasons(...)` checks many finish-reason locations:
  - `finish_reason`, `finishReason`;
  - `stop_reason`, `stopReason`;
  - `native_finish_reason`, `nativeFinishReason`;
  - provider metadata and candidate/output variants.
- `isProviderResponseTokenLimitFinishReason(...)` handles exact token-limit values and fuzzy variants such as `token_limit_reached`, `length_limit`, and `output_limit`.
- `getProviderResponseFailure(...)` classifies failures before JSON parsing:
  - token limit;
  - reasoning-only visible output;
  - empty visible output.
- `assertProviderResponseText(...)` gives callers one entry point that either returns visible text or throws a structured provider-response error.

Design lesson for Recursion: provider payload normalization should be a small reusable module. `src/providers.mjs` should not keep accumulating provider-shape branches inline.

### Structured Output Parser

Directive's `src/providers/structured-output-parser.mjs` is a repair pipeline, not just a parser.

Key behaviors:

- `stripReasoningBlocks(...)` removes `<think>...</think>` and `<reasoning>...</reasoning>` wrappers before parsing visible JSON.
- `stripMarkdownFence(...)` accepts fenced `json`, `text`, or `markdown` output.
- `extractBalancedJsonObject(...)` finds the first balanced object inside wrapper prose.
- `repairCommonJson(...)` applies general syntax repair:
  - strips BOM;
  - converts smart double quotes to ASCII quotes;
  - converts smart apostrophes to ASCII apostrophes;
  - removes line comments;
  - removes block comments;
  - removes trailing commas before `}` or `]`;
  - escapes literal line breaks inside JSON strings.
- `parseStructuredJsonText(...)` tries a candidate list in order:
  - stripped source;
  - balanced object;
  - repaired balanced object;
  - repaired stripped source;
  - optional schema-specific repair candidates.
- successful repaired parses return `repaired: true`;
- failed parses return bounded diagnostics with code, message, visible content length, and a sample.

Design lesson for Recursion: repair is allowed for syntax and wrapper damage, but not for missing semantic contract. The parser may repair commas, comments, fences, smart quotes, and literal newlines. It must not fabricate `schema`, `snapshotHash`, role ids, evidence refs, card text, budgets, or diagnostics.

### Directive Test Coverage

Directive's `tools/scripts/test-provider-response-parser.mjs` proves the parser/normalizer as a focused unit.

Covered cases include:

- chat-completion visible text extraction;
- nested content array extraction;
- reasoning-only detection;
- token-limit classification;
- fenced JSON with trailing comma;
- reasoning wrapper stripping;
- comments plus literal line breaks inside strings;
- common JSON repair;
- malformed missing operation closer recovery;
- invalid no-object rejection.

Design lesson for Recursion: the parser should have its own test script. Provider routing tests should assert integration, not carry every syntax-repair case.

## Recursion Current State

### Existing Parser

Recursion's `src/core.mjs` currently has:

- `stripFencedJson(...)`;
- `extractJsonObjectCandidate(...)`;
- `parseJsonObject(...)`.

That handles fenced JSON and wrapper prose, then calls `JSON.parse(...)`. It does not repair:

- comments;
- trailing commas;
- smart quotes;
- BOM;
- literal line breaks inside strings;
- reasoning XML-ish wrappers;
- provider text arrays beyond the currently handled OpenAI-compatible visible-text path.

### Existing Provider Normalization

Recursion's `src/providers.mjs` currently has:

- `parseOpenAiText(...)`;
- `visibleProviderText(...)`;
- `hasReasoningOnlyText(...)`;
- `containsReasoningText(...)`;
- token-limit finish reason handling.

This is useful but narrower than Directive:

- it is tied to OpenAI-compatible parsing rather than a shared provider normalizer;
- reasoning extraction is recursive but not as field-aware as Directive's normalizer;
- finish reason collection is narrower;
- direct host-provider responses are treated mostly as normalized `{ text }` objects before structured parsing.

### Recent Recursion Hardening To Preserve

The recent provider-envelope hardening should remain the first line of defense:

- every provider role gets `responseSchema`;
- machine JSON requests carry `machineJson: true`;
- OpenAI-compatible calls request schema-constrained JSON where supported;
- SillyTavern connection-profile calls pass equivalent `json_schema` metadata and skip preset/instruct injection;
- Utility Arbiter prompts explicitly name required top-level fields;
- retry prompts spell out exact `schema` and `snapshotHash` values.

Directive-style repair should run after visible text extraction and before role-schema validation. It should not weaken schema validation.

## Target Recursion Contract

Provider parsing should follow this order:

1. Send the strictest available machine-output request.
2. Receive provider payload.
3. Normalize provider payload into visible text or a classified provider-response failure.
4. Parse visible text through structured JSON repair candidates.
5. Validate top-level role schema.
6. Validate role-specific contract, including `snapshotHash` where required.
7. Record sanitized diagnostics, including whether JSON syntax repair occurred.
8. Never persist raw provider text, hidden reasoning, full prompt bodies, API keys, cookies, bearer tokens, or private story plans.

Required invariant: repair may make syntactically damaged JSON parseable, but it may not make semantically invalid output trustworthy.

Examples:

- trailing comma in a Utility Arbiter JSON object: repair and continue to schema/snapshot validation;
- `<think>draft</think>{"schema":"recursion.card.v1",...}`: strip reasoning wrapper, parse visible object, continue validation;
- object missing `schema`: parse succeeds, role schema validation rejects;
- object missing or mismatching `snapshotHash`: parse succeeds, runtime/card/composer validation rejects;
- plain prose with no object: parse rejects;
- token-limit visible partial JSON: classify as token-limit provider failure before repair;
- reasoning-only output: classify as reasoning-only provider failure before repair.

## Implementation Plan

### Task 1: Add Recursion Structured Output Parser

Files:

- Create `src/providers/structured-output-parser.mjs`.
- Create `tools/scripts/test-provider-response-parser.mjs`.

Port and adapt these general Directive behaviors:

- `stripReasoningBlocks(...)`;
- `stripMarkdownFence(...)`;
- `extractBalancedJsonObject(...)`;
- `repairCommonJson(...)`;
- `parseStructuredJsonText(...)`;
- diagnostic codes for empty, invalid JSON, and non-object JSON.

Do not port Directive's `repairMissingArrayElementObjectClosers(...)` as a default Recursion repair in this task. It is operation-schema-specific. Add a commented design note in the test file explaining that schema-specific repairs require their own recurring failure evidence and focused tests.

Focused test cases:

- strict JSON object parses with `repaired: false`;
- fenced JSON parses;
- wrapper prose with first balanced object parses;
- `<think>` and `<reasoning>` wrappers are stripped;
- comments are removed;
- trailing commas are removed;
- smart double quotes are repaired;
- BOM is stripped;
- literal line breaks inside strings are escaped;
- arrays reject when object required;
- no-object text rejects;
- missing `schema` is not added by repair.

### Task 2: Add Recursion Provider Response Normalizer

Files:

- Create `src/providers/provider-response-normalizer.mjs`.
- Extend `tools/scripts/test-provider-response-parser.mjs`.

Port and adapt these Directive behaviors:

- `extractProviderContentText(...)`;
- `extractProviderResponseText(...)`;
- `extractProviderResponseReasoning(...)`;
- `collectProviderResponseFinishReasons(...)`;
- `isProviderResponseTokenLimitFinishReason(...)`;
- `describeProviderResponse(...)`;
- `getProviderResponseFailure(...)`;
- `assertProviderResponseText(...)`.

Recursion-specific requirements:

- preserve existing stable error codes or map new helper codes to existing `RECURSION_PROVIDER_*` codes in `src/providers.mjs`;
- include `providerTitle` or lane only in sanitized diagnostics, not in persisted raw messages;
- keep visible text samples bounded and sanitized before entering diagnostics;
- do not expose hidden reasoning previews in persistent journals unless they are redacted and explicitly bounded. Safer default: record only reasoning length and failure code.

Focused test cases:

- OpenAI `choices[0].message.content`;
- `choices[0].delta.content`;
- nested content arrays;
- candidates/output arrays;
- direct `{ text }` and `{ response }`;
- reasoning-only output;
- token-limit finish reasons from multiple field names;
- empty visible output.

### Task 3: Integrate Parser Into Provider Router

Files:

- Modify `src/providers.mjs`.
- Extend `tools/scripts/test-providers.mjs`.

Replace current `parseStructuredOutput(...)` / `parseProviderStructuredOutput(...)` internals with the new parser.

Integration rules:

- `parseStructuredOutput(text)` should keep its exported shape for existing tests, but internally call `parseStructuredJsonText(text)` and throw Recursion-coded errors on failure.
- `parseProviderStructuredOutput(text)` should return both parsed data and repair metadata, or `providers.mjs` should call a helper that can attach repair metadata to diagnostics.
- router success diagnostics may include:
  - `structuredOutputRepaired: true`;
  - `structuredOutputRepairCode: "json_repaired"` or similar stable compact label;
  - `visibleContentLength`;
  - never raw provider output.
- schema mismatch retry should still happen after a repaired parse if the parsed object has the wrong or missing `schema`.
- JSON parse retry should still happen if all candidates fail.

Focused test cases:

- provider returns fenced JSON with trailing comma; router succeeds and records repaired diagnostic;
- provider returns comments and literal newline inside string; router succeeds and records repaired diagnostic;
- provider returns repaired JSON missing `schema`; router returns `RECURSION_PROVIDER_SCHEMA_MISMATCH`;
- provider returns no object; router returns `RECURSION_JSON_PARSE_FAILED`;
- provider returns token-limit payload; router returns `RECURSION_PROVIDER_TOKEN_LIMIT` before JSON repair;
- result, journal, and activity do not contain raw malformed provider text.

### Task 4: Keep Runtime Validation Authoritative

Files:

- Modify `src/runtime.mjs` only if diagnostics or progress need repair-aware display.
- Extend `tools/scripts/test-runtime.mjs`.
- Extend `tools/scripts/test-cards.mjs` if card parsing diagnostics are surfaced per-card.

Runtime must continue to reject bad semantics after parser repair:

- Utility Arbiter missing `snapshotHash`;
- Utility Arbiter mismatched `snapshotHash`;
- card missing or mismatching `role`;
- card missing or mismatching `family`;
- card missing or mismatching `snapshotHash`;
- card evidence outside current snapshot;
- prompt-facing text with hidden-reasoning wording.

If repaired output passes syntax but fails runtime validation, diagnostics should distinguish:

- `structured-output-repaired` if syntax repair occurred;
- existing semantic rejection reason, such as `invalid-snapshot-hash`, `schema-mismatch`, `invalid-card-role`, or `card-evidence-invalid`.

The progress surface already has a `repairing-card-json` stage label. Use it only if the runtime has a real repair event worth showing. Do not show a separate visible row for every repaired response; avoid progress spam.

### Task 5: Update Docs

Files:

- Modify `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`.
- Modify `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md`.
- Modify `docs/testing/TESTING_STRATEGY.md`.
- Modify `docs/user/PROVIDER_SETUP.md` only if operator-facing provider failure wording changes.

Required doc updates:

- provider-output recovery now includes wrapper stripping and safe syntax repair;
- repair never fabricates missing role contracts or snapshot hashes;
- repaired outputs remain subject to schema and role-specific validation;
- provider diagnostics may report repaired structured output without raw output text;
- tests include a dedicated parser/normalizer script.

### Task 6: Verify And Sync Live Copies

Commands:

```powershell
node tools\scripts\test-provider-response-parser.mjs
node tools\scripts\test-providers.mjs
node tools\scripts\test-runtime.mjs
npm.cmd test
npm.cmd run test:alpha
```

Live verification remains separate:

- sync changed source files into the installed Recursion extension copy used for testing;
- reload SillyTavern so browser modules refresh;
- use a dedicated `recursion-soak-*` user for scripted live proof;
- do not claim live proof from deterministic tests alone.

## What Not To Port Blindly

Directive's missing operation closer repair is useful in Directive because Directive has operation arrays with repeated `"op"` entries. Recursion's current provider roles do not use that same operation schema. Porting that repair blindly could make the parser mutate unrelated arrays in surprising ways.

Instead:

- keep the first pass to general JSON syntax repair;
- add schema-specific repair only after a real Recursion provider failure shows a repeatable malformed shape;
- require a focused failing test before any schema-specific repair is added.

Also do not loosen Recursion's machine-output acceptance:

- no prose fallback for `utilityArbiter`, card roles, composers, or provider tests;
- no accepting object-shaped output without expected `schema`;
- no accepting missing or stale `snapshotHash`;
- no repair of hidden reasoning into visible prompt-facing card text;
- no durable storage of raw provider response bodies.

## Acceptance Criteria

The robust pass is complete when:

- `tools/scripts/test-provider-response-parser.mjs` covers Directive-equivalent general normalization and repair cases;
- `src/providers.mjs` uses the shared normalizer/parser path for provider-owned structured output;
- repaired syntax is reported as sanitized metadata;
- malformed but unrecoverable output fails with stable Recursion error codes;
- semantically invalid output still fails after syntax repair;
- activity, journals, diagnostics, and artifacts do not contain raw malformed provider output or hidden reasoning;
- provider architecture and technical docs describe the new repair boundary;
- `npm.cmd test` and `npm.cmd run test:alpha` pass;
- live proof, when requested, is run only after installed-copy sync and SillyTavern reload.

## Recommended Work Order

1. Build parser and parser tests.
2. Build normalizer and normalizer tests.
3. Integrate parser/normalizer into `src/providers.mjs`.
4. Add router integration tests for repaired success and semantic rejection.
5. Add runtime/card semantic rejection regressions if any repaired output reaches those layers.
6. Update docs.
7. Run deterministic gates.
8. Sync live installed copy and perform live provider smoke only when requested.

This order keeps repair behavior isolated before it touches runtime, making failures easier to classify.
