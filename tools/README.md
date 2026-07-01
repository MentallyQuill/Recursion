# Tools

Development scripts for deterministic verification and guarded live smoke checks.

- `scripts/run-tests.mjs` - Runs all focused `test-*.mjs` scripts.
- `scripts/run-alpha-gate.mjs` - Maintained alpha gate wrapper.
- `scripts/check-playwright-readiness.mjs` - Offline Playwright/Chromium readiness probe with optional artifacts.
- `scripts/check-sillytavern-soak-users.mjs` - Dedicated `recursion-soak-*` user storage preflight.
- `scripts/smoke-sillytavern-live.mjs` - Guarded live SillyTavern smoke for served-extension freshness, storage, UI, and opt-in generation bridge prompt evidence.
- `scripts/lib/sillytavern-live-harness.mjs` - Shared live-harness helpers for auth, artifacts, redaction, storage probes, browser control, and report status.
