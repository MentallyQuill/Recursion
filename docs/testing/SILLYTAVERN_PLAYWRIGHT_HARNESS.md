# SillyTavern Playwright Harness

The Recursion Playwright harness is the shared test utility layer for browser readiness checks and focused live SillyTavern smoke tests. It borrows Directive's useful testing discipline while keeping Recursion's scope smaller: prove host integration, visible status, prompt injection, storage probes, and fail-soft behavior.

The current post-generation browser contract is Post-process Cards. The harness must drive the independent Post-process deck, verify Unified/Progressive and As Swipe/Replace controls, and inspect native host quiet-generation settlement. The older Enhancement mutation section is retained only as historical test archaeology; new proof must use `postProcess` settings, Post-process progress rows, and the current marker contract.

## Current Guardrail Files

The first executable slice has these files:

| Path | Current status |
| --- | --- |
| `tools/scripts/lib/sillytavern-live-harness.mjs` | Shared helpers for argv parsing, soak-user validation, offline Playwright readiness, SillyTavern HTTP auth, storage probes, served-extension comparison, browser UI smoke, opt-in visible-send generation smoke, prompt-key metadata capture, report writing, artifact paths, redaction, and status handling. |
| `tools/scripts/check-playwright-readiness.mjs` | Offline browser readiness probe. It dynamically imports Playwright, launches Chromium when available, drives a local fixture, and never contacts SillyTavern. |
| `tools/scripts/check-sillytavern-soak-users.mjs` | Dedicated-user safety and storage preflight. It rejects unsafe users before mutation, logs into dedicated users, writes/reads/verifies/deletes Recursion-owned probe files, and checks cross-user isolation when two or more users are configured. |
| `tools/scripts/smoke-sillytavern-live.mjs` | Focused live smoke. It validates the dedicated user and base URL gate, authenticates, compares served Recursion files, verifies the Recursion Bar, Hero Pixel Array progress menu, options/settings menu, provider controls, Last Brief dropdown, Full Viewer access, and bridge hooks with Playwright, and writes screenshots/trace for no-generation UI runs when artifacts are enabled. With generation flags, it drives visible send controls when available, records the trigger source, proves host generation continued for UI sends, suppresses binary artifacts, and proves Recursion-owned prompt keys can install and clear without storing raw prompt text. |
| `tools/scripts/prove-post-process-cards-ui.mjs` | Dedicated-user Post-process Cards UI contract: independent deck persistence, card/category ordering, binary card state, Unified/Progressive and As Swipe/Replace controls, editor behavior, and privacy-safe evidence. |
| `tools/scripts/prove-live-post-process-as-swipe.mjs` | Strict dedicated-user native generation proof: forces As Swipe, requires the native swipe plus exactly one selected Post-process swipe, validates aligned marker metadata, and reloads the chat before passing. |
| `tools/scripts/test-live-harness.mjs` | Deterministic contract tests for the guardrail behavior. |

The harness should be a library, not a second runtime. Runtime behavior stays in `src/`; the harness drives the public host/UI surface and reads documented diagnostics.

## Environment

Common environment variables:

| Variable | Meaning |
| --- | --- |
| `SILLYTAVERN_BASE_URL` | Base URL for the local SillyTavern host, such as `http://127.0.0.1:8000`. Required for live tests. |
| `RECURSION_SILLYTAVERN_USER` | Single dedicated test user for one live smoke run. Must match `recursion-soak-*`; must not be `default-user`. |
| `RECURSION_SOAK_ST_USERS` | Comma-separated dedicated users for isolation checks, such as `recursion-soak-a,recursion-soak-b,recursion-soak-c`. |
| `RECURSION_SILLYTAVERN_PASSWORD` | Password for account-mode SillyTavern when one shared password is enough. |
| `RECURSION_SILLYTAVERN_PASSWORD_<USER>` | Per-user password override, where the user handle is uppercased and non-alphanumeric characters become underscores. |
| `RECURSION_PLAYWRIGHT_HEADFUL` | Set to `1` for visible browser debugging. Default is headless. |
| `RECURSION_PLAYWRIGHT_TIMEOUT_MS` | Browser-control timeout for readiness checks. |
| `RECURSION_LIVE_TIMEOUT_MS` | Browser-control timeout for live host checks. |
| `RECURSION_LIVE_GENERATION` | Set to `1` to run opt-in visible-send generation smoke after the safe preflight and UI evidence. This may call the configured Utility provider through Recursion. |
| `RECURSION_LIVE_REASONER` | Set to `1` to request the Reasoner-capable generation path. This implies visible-send generation smoke, or the recorded direct-bridge fallback when no visible send controls are available, and may call configured Utility/Reasoner providers. Partial or disabled visible send surfaces fail instead of falling back. Prompt metadata records bounded composer/Reasoner fallback status only, never raw provider error text. |
| `RECURSION_LIVE_STRICT` | Set to `1` to promote warnings to failures. |
| `RECURSION_ARTIFACT_DIR` | Override artifact root for reports, traces, screenshots, and logs. |

Scripts should print a dry-run checklist when required live variables are missing. State-mutating scripts must fail before mutation when no dedicated user is configured. No live script may infer, create, or select `default-user` as a fallback.

If `--dry-run` is passed with `--live`, dry-run wins and the report must include a warning. This keeps an explicit safety flag from being bypassed by a broader command alias.

`--strict` and `RECURSION_LIVE_STRICT=1` both enable strict mode in reports.

## Enhancement Mutation Certification

Run the configured-provider gate with:

```powershell
$env:SILLYTAVERN_BASE_URL = 'http://127.0.0.1:8000'
$env:RECURSION_SILLYTAVERN_USER = 'recursion-soak-a'
npm.cmd run prove:enhancements-live
```

The default matrix runs both `Redirect` and `Repair` under Standard, Rapid, and Fused. A diagnostic run may set `RECURSION_ENHANCEMENT_PROOF_CASE` to a pipeline/mode pair such as `standard-repair`; only the unfiltered command is the complete matrix.

The shared live-enhancement oracle receives the configured Enhancement mode, concrete assistant state before and after the run, the runtime Enhancement return value, and the final Editorial settlement. For enabled `As Swipe`, pass requires exactly one appended swipe, selection of that appended swipe, changed text, and a persisted Recursion marker whose identity and hashes match the source and candidate. `Replace` has a separate in-place contract and must not change swipe count. `Off` must not mutate.

The runner fails on skipped, warning, error, or `partial-failed` settlement even when a provider call returned parseable JSON. Repair must return a nonempty bounded-patch artifact; returning a full candidate fails. Redirect must also pass its production verifier and independent effectiveness judge. Provider completion and green intermediate rows are supporting evidence only.

The report classifies this deterministic corpus as `served-runtime-synthetic-message-real-provider`. It uses the production runtime, configured providers, host adapter, and actual SillyTavern page, but keeps its deliberately flawed source messages out of durable chat storage. Therefore it certifies in-page message mutation and marker binding, not save/reload durability. The visible-send `prove:card-progress-live` path separately captures the real initial host assistant state and owns native-chat mutation evidence.

## Dedicated User Policy

State-mutating live scripts must require a dedicated Recursion soak user. The accepted handle pattern is:

```text
recursion-soak-*
```

Automated live tests must reject these handles:

```text
default-user
default
user
```

Example accepted handles:

```text
recursion-soak-a
recursion-soak-b
recursion-soak-c
```

The live harness should expose a `normalizeSoakUserHandle(value)` helper and a `rejectUnsafeLiveUser(value)` helper. Rejection must happen before login, browser navigation, storage probes, chat creation, prompt injection, or provider calls.

This is a hard safety gate, not a warning. If the selected user is missing, empty, `default-user`, an alias for the default profile, or does not match the dedicated soak-user pattern, the script must return `unsafe-user` and stop before mutating SillyTavern state.

Multi-user checks must also reject duplicate normalized handles. `recursion-soak-a,recursion-soak-a` is unsafe because it cannot prove cross-user isolation.

## Browser Readiness Flow

The readiness command is safe to run before SillyTavern starts. By default it attempts an offline Playwright browser check:

```powershell
node tools\scripts\check-playwright-readiness.mjs --write-artifacts
```

If Playwright is not available, it returns a sanitized `environment-fail` report instead of a stack trace. Use `--dry-run` to write a no-op checklist without importing Playwright.

The readiness implementation:

1. Create a run id.
2. Launch Playwright Chromium.
3. Create one page with a local HTML fixture.
4. Click a role or label locator.
5. Assert that the click changed visible fixture state.
6. Capture console messages and page errors.
7. Switch to desktop viewport.
8. Capture a desktop screenshot.
9. Switch to phone viewport.
10. Capture a phone screenshot.
11. Stop a Playwright trace when artifact capture is enabled.

## Installed-Copy Identity Gate

Every live proof must verify the exact extension bytes before Playwright
navigation, chat mutation, or provider calls:

```powershell
node tools\scripts\verify-installed-copy.mjs --user recursion-soak-a
```

The verifier compares SHA-256 hashes for the repository production allowlist,
the selected user's installed extension, and the served public extension. A
missing, extra, content-mismatched, or symlinked production file fails the gate.
The report must identify only safe relative paths and hashes; it must not inspect
chat files, settings, or secrets. Dedicated `recursion-soak-*` users remain the
required target for automated live proof. Run the same verifier with
`--user default-user` only before an explicitly approved default-user proof.

The browser harness does not replace this identity check with DOM version text
or a partial served-file comparison.
12. Write `report.json` and `summary.md`.

## Live Preflight Flow

State-mutating live smoke must run preflight checks before changing chat or prompt state:

1. Normalize and validate the configured user.
2. Reject `default-user`.
3. Authenticate if SillyTavern account mode requires it.
4. Fetch the served Recursion manifest.
5. Compare the served manifest entrypoint, stylesheet, and local static ESM import graph against the checkout under test.
6. Write, verify, read, and delete one Recursion-owned `/user/files` probe.
7. Confirm Playwright can open the host and see the Recursion Bar.
8. Confirm the Hero Pixel Array progress menu, Last Brief dropdown, settings/options menu, Full Viewer access, and bridge hooks are available without sending a chat message.

The served freshness gate must cover the browser-loaded implementation, not just the manifest shell:

- `manifest.json`;
- manifest `js` entrypoint;
- every local static ESM import reachable from the entrypoint;
- manifest `css` file;
- local fallback entries for the extension entrypoint and stylesheet when the manifest cannot enumerate them.

Reports must distinguish `served-extension-match`, `served-extension-mismatch`, and `served-extension-unavailable`. A mismatch or unavailable served extension blocks storage mutation and browser smoke in automated runs.

## Multi-User Isolation Flow

`check-sillytavern-soak-users.mjs` validates configured handles and writes guardrail reports. Without `--live`, missing users are a skipped dry-run checklist. With `--live`, unsafe users return `unsafe-user` before mutation. Safe users authenticate through SillyTavern, write/read/verify/delete Recursion-owned probe files, and report `environment-fail` if auth or host setup prevents the check.

The implementation proves dedicated users are isolated before broader live checks:

1. Parse `RECURSION_SOAK_ST_USERS`.
2. Require at least one user and reject any unsafe handle.
3. For each user, authenticate and write a unique Recursion probe file.
4. For each user, verify its own probe is visible.
5. For each user, verify other users' probes are not visible.
6. Delete all probes.
7. Write one aggregate report with per-user status.

The probe payload should be small and harmless:

```json
{
  "recordType": "recursion.liveProbe",
  "schemaVersion": 1,
  "runId": "example-run-id",
  "owner": "recursion-soak-a",
  "createdAt": "2026-06-30T00:00:00.000Z"
}
```

The probe must use a Recursion-owned logical key or filename prefix and must not touch chat files, character files, World Info, Memory Books, Summaryception, VectFox, or non-Recursion extension files.

When only one user is configured, the script verifies that user's storage but emits a warning because cross-user isolation cannot be evaluated.

## Live Smoke Browser Flow

`smoke-sillytavern-live.mjs` should prefer user-visible interactions:

- navigate to SillyTavern;
- ensure the Recursion extension is mounted;
- locate the Recursion Bar;
- open the options/settings menu;
- open the Hero Pixel Array progress menu;
- switch disabled power, Standard/Rapid/Fused Pipeline, Auto, and Manual states;
- render Utility and Reasoner capability as Configure, Untested, Ready, or Unhealthy with no provider enable control;
- keep Medium+ Redirect visible but unavailable when Reasoner is unconfigured or unhealthy, show Untested as a routable caution, preserve the prior Enhancement selection on an unavailable click, and keep Low Redirect available through Utility;
- seed and clear a Recursion-owned prompt sentinel during no-generation mode smoke;
- run Test Provider actions through visible controls when configured;
- send a safe test message only when the live run explicitly allows chat mutation;
- wait for Recursion progress states instead of sleeping blindly;
- open Last Brief and prove Full Viewer access;
- capture screenshots for desktop and phone viewports during no-generation UI runs;
- clear prompt injection through power-off or teardown.

No-generation browser snapshots include a sanitized `modeSmoke` object with the exact disabled -> Auto -> Manual -> disabled sequence, observed mode labels, selected Pipeline state, power state, and Recursion prompt key names. Prompt text is not captured.

`page.evaluate()` is acceptable for:

- reading a documented Recursion runtime bridge snapshot;
- checking prompt packet metadata that is not visible in the UI;
- extracting sanitized run journal summaries;
- diagnosing host readiness when visible controls are not enough.

It should not be the primary way to mutate chat state when a visible host control exists.

## Selector Rules

Prefer stable selectors in this order:

1. roles and accessible names;
2. labels and titles;
3. `data-recursion-*` attributes;
4. stable SillyTavern host ids;
5. CSS classes as a last resort.

UI implementation should provide testable attributes for Recursion-owned surfaces:

```text
data-recursion-bar
data-recursion-activity-ribbon
data-recursion-action
data-recursion-action-menu
data-recursion-hand-dropdown
data-recursion-settings-panel
data-recursion-viewer
data-recursion-provider-test
data-recursion-prompt-packet
```

If a click times out while an element exists, the harness should capture bounding boxes, computed visibility, and overlap hints before retrying. Screenshots are allowed only when the run is not generation-enabled. Coordinate clicks are diagnostic fallbacks and must be labeled in the report.

## Artifacts

The harness writes artifacts under:

```text
artifacts/live-smoke/sillytavern/<run-id>/
```

Readiness-only checks may write under:

```text
artifacts/playwright-readiness/<run-id>/
```

Required artifact shape is defined in [Artifact Contract](ARTIFACT_CONTRACT.md).

No-generation UI smoke may write screenshots and Playwright traces for visible UI proof. Generation-enabled smoke must not write screenshots or traces because binary artifacts can capture chat or model text that normal redaction scans cannot inspect. Documentation render promotion is handled separately through [Documentation Render Tracking](DOCUMENTATION_RENDER_TRACKING.md); raw harness artifacts are not promoted directly.

## Redaction

The harness must pass all report payloads through the same redaction helper used by diagnostics tests.

Always remove or replace:

- API keys;
- authorization headers;
- cookies;
- CSRF tokens;
- passwords;
- session ids;
- raw provider prompts;
- raw provider responses;
- full transcript text;
- hidden reasoning;
- private notes;
- absolute local paths when a logical artifact path is enough.

Screenshots are allowed because they prove visible UI behavior. They should not be captured while provider secrets are visible in settings fields.

Screenshots and traces are disallowed for generation-enabled runs. Use prompt-key hashes, lengths, placement metadata, hand readiness, and prompt-packet metadata for that evidence path.

## Failure Handling

Harness failures should be actionable:

- `environment-fail`: browser, host, auth, filesystem, network, or provider setup failed.
- `stale-extension`: served files do not match the checkout under test.
- `unsafe-user`: the configured user is `default-user`, empty, or otherwise unsafe.
- `recursion-fail`: Recursion violated a runtime, UI, prompt, storage, or redaction contract.
- `manual-required`: the host needs a human step before automation can proceed.

Do not hide a failed live host check behind a direct runtime call. Direct runtime calls are useful for diagnosis, but browser-visible smoke evidence must remain honest about what the user would experience.
