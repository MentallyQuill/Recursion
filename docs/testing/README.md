# Testing

This folder defines Recursion's verification strategy, Playwright harness contract, focused live SillyTavern smoke plan, and artifact rules.

Start with [Testing Strategy](TESTING_STRATEGY.md).

## Documents

- [Testing Strategy](TESTING_STRATEGY.md): three-layer verification stack, core invariants, dedicated live-user policy, pass/fail semantics, and V1 non-goals.
- [SillyTavern Playwright Harness](SILLYTAVERN_PLAYWRIGHT_HARNESS.md): target harness files, environment variables, dedicated user checks, browser flow, selector rules, and failure categories.
- [Live Smoke Test Plan](LIVE_SMOKE_TEST_PLAN.md): focused Recursion live scenarios for mount, modes, provider controls, Observe, Auto, prompt cleanup, fallback, and responsive UI.
- [Artifact Contract](ARTIFACT_CONTRACT.md): report, live-log, screenshot, prompt metadata, storage probe, redaction, and retention rules.
- [Implementation Plan](IMPLEMENTATION_PLAN.md): staged build order and verification gates for the extension.

## Live User Rule

Automated live tests must reject `default-user`. Use dedicated SillyTavern users such as:

```text
recursion-soak-a
recursion-soak-b
recursion-soak-c
```

`default-user` is reserved for manual human testing and must not produce automated pass/fail evidence.
