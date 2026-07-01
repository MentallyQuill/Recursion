# Testing Strategy

Recursion testing should prove the extension is useful and safe without turning every verification path into a live SillyTavern run. The test framework has three layers:

| Layer | What it proves | Primary evidence |
| --- | --- | --- |
| Fast contract suite | Runtime contracts, schemas, card lifecycle, provider routing, storage, redaction, and prompt packet rules work without a live host. | Maintained deterministic gate: `node tools\scripts\run-alpha-gate.mjs`; focused scripts: `tools/scripts/test-*.mjs`. |
| Playwright readiness | Offline probe proves the local machine can launch/control Chromium through Playwright, use a role locator, switch desktop/phone viewports, and write trace/screenshot artifacts. If Playwright is unavailable, it returns `environment-fail` without contacting SillyTavern. | Current evidence: `check-playwright-readiness` report, trace, and viewport screenshots when Playwright is installed; otherwise a sanitized environment-fail report. |
| Focused live SillyTavern smoke | Current preflight proves dedicated-user rejection, dry-run behavior, report shape, fail-closed semantics, Recursion-owned storage probes, served-extension freshness, no-generation UI mount/open behavior, and opt-in generation bridge prompt-install evidence. | Current evidence: `check-sillytavern-soak-users` storage-probe reports and `smoke-sillytavern-live` reports, screenshots, trace, live log, served-extension comparison, storage probe artifact, browser snapshot, prompt-key hashes, hand readiness, and prompt-packet metadata. |

The fast contract suite is the normal maintained confidence gate in this checkout. The live-harness scripts validate dedicated users, dry-run behavior, report shape, artifact paths, fail-closed semantics, offline Playwright readiness, SillyTavern storage probes when dedicated users are available, no-generation SillyTavern UI evidence, and opt-in generation bridge evidence when Recursion is installed for a dedicated user.

## Core Invariants

Highest-priority invariants:

- Off mode performs no chat inspection, provider calls, card updates, or prompt injection.
- Observe mode may capture diagnostics and preview decisions but must not install prompt packets.
- Auto mode may install prompt packets only through Recursion-owned SillyTavern prompt keys.
- Prompt packet installation is replace-or-clear by Recursion metadata, not blind append.
- Stale provider results cannot update the active scene cache or active prompt packet.
- Utility is the default provider lane for Arbiter and composition work.
- Reasoner composition is optional and must fall back to Utility or local composition on timeout, failure, disabled state, or invalid schema.
- Direct endpoint API keys are session-only and never written to settings, cache, journals, reports, screenshots, debug exports, or prompt packets.
- Raw provider prompts and raw provider responses are not persisted by default.
- Character Motivation cards may produce behavior-facing motivation guidance but must not inject private internal-thought dumps.
- Activity Ribbon stages visibly report foreground model calls, cache reuse, card refresh, prompt install, storage progress, fallback paths, warnings, and errors.
- Provider failure, storage failure, or injection failure must not block normal SillyTavern generation.
- Recursion tests must not mutate World Info, Memory Books, Summaryception, VectFox, unrelated SillyTavern data, or non-Recursion extension records.
- Automated live tests must reject `default-user`. Use dedicated test users such as `recursion-soak-a`, `recursion-soak-b`, and `recursion-soak-c`.

## Fast Contract Suite

The contract suite is runnable before any live SillyTavern host work. It uses the installed Playwright dev dependency for offline browser readiness and does not contact SillyTavern. The maintained gate command is:

```powershell
node tools\scripts\run-alpha-gate.mjs
```

The gate calls the focused local suite rather than duplicating test logic. Coverage groups:

- manifest and extension shell identity;
- host adapter fake contracts;
- settings normalization and session-only secret handling;
- logical storage key safety;
- scene cache schema validation;
- run journal redaction and ring-buffer pruning;
- provider lane routing and structured response parsing;
- Utility Arbiter Auto Control Plan validation;
- card catalog, lifecycle, emphasis, detail, and hand-selection contracts;
- Utility and Reasoner prompt packet composition;
- prompt budget trimming and omission reasons;
- prompt injection metadata, replacement, and clearing through a fake host;
- activity event normalization and user-safe status text.

Focused contract tests should use deterministic fixtures and fake provider responses before live providers. If a live smoke finds a defect, add a focused contract regression where the behavior can be isolated without browser control.

## Playwright Readiness

The Playwright readiness command must not contact SillyTavern. It proves browser automation is available before any live chat, user file, prompt, or provider state is touched. When Playwright is missing, it returns `environment-fail` with sanitized details.

The readiness probe should:

- launch Chromium through Playwright;
- drive a role or label locator click;
- capture console errors and page errors;
- switch between desktop and phone viewports;
- write screenshots and a trace when artifact capture is enabled;
- emit a concise JSON report and Markdown summary.

Readiness failures are environment failures, not Recursion runtime failures.

## Live SillyTavern Smoke

The current live smoke command is a guardrail script that validates safe user configuration and fails closed before mutation. The target live smoke proves Recursion in the real host. It should be focused and repeatable, not a Directive-style campaign certification run.

Live smoke must start with these gates:

- `SILLYTAVERN_BASE_URL` is configured and reachable.
- The configured SillyTavern user is a dedicated `recursion-soak-*` user.
- `default-user` is rejected before any mutation.
- Served extension manifest and selected source assets match the checkout under test, or the report clearly marks the run as stale/untrusted.
- The dedicated user can write, read, verify, and delete a Recursion-owned storage probe.
- Multi-user runs prove each configured soak user can see its own probe and cannot see another user's probe.
- Playwright readiness has passed in the current environment.

Primary live scenarios:

- extension mount and Recursion Bar render;
- mode transitions: Off, Observe, Auto;
- provider setup display and Test Provider action for Utility and Reasoner;
- Observe mode diagnostics without prompt injection;
- Auto mode Utility Arbiter pass, card refresh, hand selection, prompt packet composition, and prompt installation;
- Last Hand dropdown reflects the cards used for the last prompt packet;
- Activity Ribbon shows model-call, cache, storage, composition, injection, fallback, and settled states;
- full viewer opens Now, Deck, Activity, Prompt Packet, Settings, and Providers views;
- prompt packet clear on Off mode, chat change, disable, and teardown;
- Utility provider failure falls back without blocking host generation;
- Reasoner failure falls back to Utility or local composition without blocking host generation;
- storage repair and journal pruning report logical progress without leaking physical paths.

Generation-enabled smoke may use real model calls only when explicitly enabled by `RECURSION_LIVE_GENERATION=1` or `RECURSION_LIVE_REASONER=1`. The runner first completes the same dedicated-user, served-extension, storage, and UI checks as no-generation smoke, then switches Recursion to Auto, wraps `setExtensionPrompt` to record only Recursion prompt keys, hashes, lengths, and placement metadata, calls the public `recursionGenerationInterceptor`, and asserts visible hand readiness plus prompt-packet metadata. It does not score writing quality or store raw provider prompts/responses.

## Dedicated Live Users

Automated live tests use dedicated SillyTavern users:

```text
recursion-soak-a
recursion-soak-b
recursion-soak-c
```

Additional users may follow the same `recursion-soak-*` prefix. Scripts must normalize user handles and reject empty handles, `default-user`, ambiguous aliases for the default profile, and any non-dedicated handle before login, browser navigation, storage probes, chat mutation, prompt injection, or provider calls.

Harness code must not use `default-user` as a convenience fallback when a user is missing. Missing or unsafe user configuration is either a dry-run checklist for non-mutating commands or an `unsafe-user` failure for state-mutating commands.

`default-user` is manual-only. It may be used by a human operator for exploratory checks, but it must not produce automated pass/fail evidence and must not be accepted by state-mutating scripts.

## Artifact Policy

Every live run writes a timestamped report folder under:

```text
artifacts/live-smoke/sillytavern/<run-id>/
```

Required artifact families are defined in [Artifact Contract](ARTIFACT_CONTRACT.md). Normal reports should store hashes, ids, counts, bounded status text, screenshots, and traces. They should not store raw provider prompts, raw provider responses, full transcript archives, API keys, cookies, authorization headers, private notes, or hidden reasoning.

## Pass And Fail Semantics

Use these result categories:

- `pass`: required checks completed and no blocking warnings remain.
- `fail`: Recursion behavior violates a contract.
- `environment-fail`: browser, SillyTavern, auth, provider, filesystem, or network conditions prevented a valid run.
- `stale-extension`: SillyTavern served code does not match the checkout under test.
- `manual-required`: the script cannot safely proceed without a human action.
- `skipped`: a check was intentionally not run because its opt-in flag was absent.

Warnings may be acceptable for exploratory local smoke. Strict mode should promote warnings to failures.

## Non-Goals

V1 testing should not build:

- a 50-turn campaign soak;
- story-quality certification;
- campaign-specific factual-grounding review;
- cross-extension certification for Memory Books, Summaryception, VectFox, or World Info;
- long-form transcript replay;
- save branching proof;
- destructive edit/delete recovery proof beyond Recursion-owned prompt/cache cleanup;
- model-cost benchmarking beyond basic duration and token diagnostics.

Those are useful for Directive because Directive owns campaign state. Recursion owns a current-scene prompt compiler. Its live proof should stay aligned to that boundary.
