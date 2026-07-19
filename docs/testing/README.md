# Testing

This folder defines Recursion's verification strategy, Playwright harness contract, focused live SillyTavern smoke plan, artifact rules, and documentation render tracking.

Start with [Testing Strategy](TESTING_STRATEGY.md).

## Documents

- [Testing Strategy](TESTING_STRATEGY.md): three-layer verification stack, Pre-process/Post-process proof matrix, core invariants, dedicated live-user policy, pass/fail semantics, and V1 non-goals.
- [SillyTavern Playwright Harness](SILLYTAVERN_PLAYWRIGHT_HARNESS.md): target harness files, environment variables, dedicated user checks, browser flow, selector rules, and failure categories.
- [Live Smoke Test Plan](LIVE_SMOKE_TEST_PLAN.md): focused Recursion live scenarios for mount, modes, provider controls, Manual, Auto, prompt cleanup, fallback, and responsive UI.
- [Artifact Contract](ARTIFACT_CONTRACT.md): report, live-log, screenshot, prompt metadata, storage probe, redaction, and retention rules.
- [Documentation Render Tracking](DOCUMENTATION_RENDER_TRACKING.md): open `<Render Needed>` inventory, source types, target assets, promotion workflow, redaction constraints, and render verification commands.
- [Implementation Plan](IMPLEMENTATION_PLAN.md): staged build order and verification gates for the extension.

## Live User Rule

Automated, scripted, or artifact-producing live tests must reject `default-user`. Use dedicated SillyTavern users such as:

```text
recursion-soak-a
recursion-soak-b
recursion-soak-c
```

This is a hard safety gate. Harness defaults must not silently fall back to `default-user`, default-profile aliases, or any non-`recursion-soak-*` handle. State-mutating scripts must return `unsafe-user` before login, browser navigation, storage probes, chat mutation, prompt injection, or provider calls.

`default-user` is reserved for manual human testing and must not produce automated pass/fail evidence.
