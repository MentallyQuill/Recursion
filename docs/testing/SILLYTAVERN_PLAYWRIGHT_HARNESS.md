# SillyTavern Playwright Harness

The Recursion Playwright harness is the shared test utility layer for browser readiness checks and focused live SillyTavern smoke tests. It borrows Directive's useful testing discipline while keeping Recursion's scope smaller: prove host integration, visible status, prompt injection, storage probes, and fail-soft behavior.

## Future Target Files

The implementation should create these files:

| Path | Purpose |
| --- | --- |
| `tools/scripts/lib/sillytavern-live-harness.mjs` | Shared Playwright, auth, artifact, storage-probe, screenshot, redaction, and served-extension helpers. |
| `tools/scripts/check-playwright-readiness.mjs` | Offline browser-control preflight. It does not contact SillyTavern. |
| `tools/scripts/check-sillytavern-soak-users.mjs` | Live user isolation and storage-probe preflight for dedicated `recursion-soak-*` users. |
| `tools/scripts/smoke-sillytavern-live.mjs` | Focused live Recursion smoke runner. |

The harness should be a library, not a second runtime. Runtime behavior stays in `src/`; the harness drives the public host/UI surface and reads documented diagnostics.

## Environment

Common environment variables:

| Variable | Meaning |
| --- | --- |
| `SILLYTAVERN_BASE_URL` | Base URL for the local SillyTavern host, such as `http://127.0.0.1:8000`. Required for live tests. |
| `RECURSION_SILLYTAVERN_USER` | Single dedicated test user for one live smoke run. Must not be `default-user`. |
| `RECURSION_SOAK_ST_USERS` | Comma-separated dedicated users for isolation checks, such as `recursion-soak-a,recursion-soak-b,recursion-soak-c`. |
| `RECURSION_SILLYTAVERN_PASSWORD` | Password for account-mode SillyTavern when one shared password is enough. |
| `RECURSION_SILLYTAVERN_PASSWORD_<USER>` | Per-user password override, where the user handle is uppercased and non-alphanumeric characters become underscores. |
| `RECURSION_SILLYTAVERN_HEADLESS` | Set to `0` for visible browser debugging. Default is headless. |
| `RECURSION_PLAYWRIGHT_TIMEOUT_MS` | Browser-control timeout for readiness checks. |
| `RECURSION_SILLYTAVERN_TIMEOUT_MS` | Browser-control timeout for live host checks. |
| `RECURSION_LIVE_GENERATION` | Set to `1` to allow real provider calls during live smoke. |
| `RECURSION_LIVE_STRICT` | Set to `1` to promote warnings to failures. |
| `RECURSION_ARTIFACT_DIR` | Override artifact root for reports, traces, screenshots, and logs. |
| `RECURSION_CONFIRM_EXTENSION_SYNCED` | Operator acknowledgement used only when the served-extension hash check cannot run. Reports must mark this as weaker than hash proof. |

Scripts should print a dry-run checklist when required live variables are missing. State-mutating scripts must fail before mutation when no dedicated user is configured.

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

The accepted pattern is:

```text
recursion-soak-a
recursion-soak-b
recursion-soak-c
```

The live harness should expose a `normalizeSoakUserHandle(value)` helper and a `rejectUnsafeLiveUser(value)` helper. Rejection must happen before login, browser navigation, storage probes, chat creation, prompt injection, or provider calls.

This is a hard safety gate, not a warning. If the selected user is missing, empty, `default-user`, an alias for the default profile, or does not match the dedicated soak-user pattern, the script must return `unsafe-user` and stop before mutating SillyTavern state.

## Browser Readiness Flow

`check-playwright-readiness.mjs` should:

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
12. Write `report.json` and `summary.md`.

When implemented, this command must be safe to run before SillyTavern starts:

```powershell
node tools\scripts\check-playwright-readiness.mjs --write-artifacts
```

## Live Preflight Flow

State-mutating live smoke must run preflight checks before changing chat or prompt state:

1. Normalize and validate the configured user.
2. Reject `default-user`.
3. Authenticate if SillyTavern account mode requires it.
4. Fetch the served Recursion manifest.
5. Compare selected served files against the checkout under test.
6. Write, verify, read, and delete one Recursion-owned `/user/files` probe.
7. Confirm Playwright can open the host and see a chat surface.
8. Confirm the Recursion extension is enabled or report that it must be enabled manually.

The selected served files should be small and representative:

- `manifest.json`;
- extension entrypoint;
- host adapter entrypoint;
- Recursion Bar UI module;
- main stylesheet;
- package/version metadata when present.

Reports must distinguish `served-extension-match`, `served-extension-mismatch`, `served-extension-unavailable`, and `operator-confirmed-sync`.

## Multi-User Isolation Flow

`check-sillytavern-soak-users.mjs` should prove that dedicated users are isolated before broader live checks:

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

## Live Smoke Browser Flow

`smoke-sillytavern-live.mjs` should prefer user-visible interactions:

- navigate to SillyTavern;
- ensure the Recursion extension is mounted;
- locate the Recursion Bar;
- open the Actions menu;
- switch Off, Observe, and Auto modes;
- run Test Provider actions through visible controls when configured;
- send a safe test message only when the live run explicitly allows chat mutation;
- wait for Recursion Activity Ribbon states instead of sleeping blindly;
- open Last Hand and Full Viewer;
- capture screenshots for desktop and phone viewports;
- clear prompt injection through Off mode or teardown.

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
data-recursion-hand-dropdown
data-recursion-viewer
data-recursion-provider-test
data-recursion-prompt-packet
```

If a click times out while an element exists, the harness should capture bounding boxes, computed visibility, overlap hints, and a screenshot before retrying. Coordinate clicks are diagnostic fallbacks and must be labeled in the report.

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

## Failure Handling

Harness failures should be actionable:

- `environment-fail`: browser, host, auth, filesystem, network, or provider setup failed.
- `stale-extension`: served files do not match the checkout under test.
- `unsafe-user`: the configured user is `default-user`, empty, or otherwise unsafe.
- `recursion-fail`: Recursion violated a runtime, UI, prompt, storage, or redaction contract.
- `manual-required`: the host needs a human step before automation can proceed.

Do not hide a failed live host check behind a direct runtime call. Direct runtime calls are useful for diagnosis, but browser-visible smoke evidence must remain honest about what the user would experience.
