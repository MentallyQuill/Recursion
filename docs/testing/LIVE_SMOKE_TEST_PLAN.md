# Live Smoke Test Plan

The live smoke plan proves Recursion inside a real SillyTavern browser session. It is focused on Recursion's product boundary: current-scene prompt compilation, visible activity, prompt injection, cache storage, provider fallback, and cleanup.

It is not a long-form story soak or campaign certification run.

## Required Conditions

Before a live smoke can mutate host state:

- SillyTavern is reachable at `SILLYTAVERN_BASE_URL`.
- The configured user is a dedicated `recursion-soak-*` user.
- `default-user`, default-profile aliases, empty handles, and non-dedicated handles have been rejected with `unsafe-user`.
- Playwright readiness has passed.
- Served Recursion manifest and selected source files match the checkout under test, or the report is marked `stale-extension`.
- The dedicated user passed a Recursion storage probe.
- Recursion is enabled in SillyTavern.
- Utility provider settings are configured when generation-enabled smoke is requested.
- Reasoner provider settings are configured when Reasoner smoke is requested.

Manual exploratory checks may use other users, but automated pass/fail evidence must come from dedicated users.

## Current Deterministic Evidence

The maintained automated gate in this checkout is the local contract suite:

```powershell
node tools\scripts\run-alpha-gate.mjs
```

It launches offline Playwright readiness, but does not contact SillyTavern, mutate chat state, or produce live-smoke artifacts. It includes deterministic coverage for the live-harness guardrail slice.

## Current Guardrail Commands

The commands in this section currently prove safety gates, report shape, and offline Playwright readiness when Playwright is installed. They do not contact SillyTavern unless a live script is run with `--live`. Live scripts reject unsafe users before mutation and return `manual-required` for deferred browser/storage work.

Offline Playwright readiness:

```powershell
node tools\scripts\check-playwright-readiness.mjs --write-artifacts
```

Use `--dry-run` when you want a no-op readiness checklist without importing Playwright.

Dedicated user isolation guardrail:

```powershell
$env:SILLYTAVERN_BASE_URL='http://127.0.0.1:8000'
$env:RECURSION_SOAK_ST_USERS='recursion-soak-a,recursion-soak-b,recursion-soak-c'
node tools\scripts\check-sillytavern-soak-users.mjs --live --write-artifacts
```

No-generation live UI and storage smoke target:

```powershell
$env:SILLYTAVERN_BASE_URL='http://127.0.0.1:8000'
$env:RECURSION_SILLYTAVERN_USER='recursion-soak-a'
node tools\scripts\smoke-sillytavern-live.mjs --live --write-artifacts
```

Generation-enabled Utility smoke:

```powershell
$env:SILLYTAVERN_BASE_URL='http://127.0.0.1:8000'
$env:RECURSION_SILLYTAVERN_USER='recursion-soak-a'
$env:RECURSION_LIVE_GENERATION='1'
node tools\scripts\smoke-sillytavern-live.mjs --live --write-artifacts --strict
```

Reasoner-enabled smoke:

```powershell
$env:SILLYTAVERN_BASE_URL='http://127.0.0.1:8000'
$env:RECURSION_SILLYTAVERN_USER='recursion-soak-b'
$env:RECURSION_LIVE_GENERATION='1'
$env:RECURSION_LIVE_REASONER='1'
node tools\scripts\smoke-sillytavern-live.mjs --live --write-artifacts --strict
```

The current `smoke-sillytavern-live.mjs` command stops at guardrail checks. Later live-browser implementation must keep the dedicated `recursion-soak-*` safety policy and must reject unsafe users before any state mutation.

## Scenario Matrix

| Scenario | Mutates chat | Requires provider | Must prove |
| --- | --- | --- | --- |
| Mount smoke | no | no | Recursion extension loads, Recursion Bar renders, Activity Ribbon can open, viewer can open. |
| Mode smoke | no | no | Off, Observe, and Auto controls update runtime mode and visible status. |
| Storage probe | files only | no | Dedicated user can write/read/delete Recursion-owned files and records are isolated from other users. |
| Observe smoke | optional | no | Snapshot and diagnostics can be previewed without prompt injection. |
| Utility provider smoke | yes | Utility | Arbiter/card/composer work runs, Activity Ribbon reports it, prompt packet installs, and generation continues. |
| Reasoner fallback smoke | yes | Utility and Reasoner | Reasoner can compose when healthy and falls back to Utility when disabled, timed out, or invalid. |
| Prompt cleanup smoke | no | no | Off mode, disable, teardown, and chat change clear Recursion prompt keys. |
| Failure smoke | optional | simulated or real failing lane | Provider/storage/injection failure reports visible fallback and does not block host generation. |
| Responsive UI smoke | no | no | Desktop and phone viewport screenshots show no overlap with chat controls. |

## Detailed Flow

The live runner should execute these stages in order.

### 1. Preflight

- Validate environment variables.
- Reject unsafe users.
- Authenticate when needed.
- Compare served extension files to the checkout.
- Confirm extension enablement.
- Run storage probe.
- Open SillyTavern with Playwright.
- Capture baseline console and page-error state.

The run stops here on unsafe user, stale extension, missing host, failed auth, or failed storage isolation.

### 2. Mount And UI

- Locate the Recursion Bar.
- Assert the bar has a stable status chip.
- Open the Actions menu.
- Open Last Hand.
- Open Full Viewer.
- Visit Now, Deck, Activity, Prompt Packet, Settings, and Providers views.
- Capture desktop screenshot.
- Capture phone viewport screenshot.

The smoke should fail if controls overlap chat input, if text escapes compact controls, or if the Activity Ribbon cannot render a clear status.

### 3. Mode Transitions

- Set Off mode and verify prompt keys are absent or cleared.
- Set Observe mode and verify no prompt packet is installed.
- Set Auto mode and verify the runtime is ready to compile when a generation begins.
- Return to Off mode and verify cleanup.

Mode changes should be visible in the bar and should append sanitized activity events.

### 4. Provider Controls

When providers are configured:

- Run Utility Test Provider.
- Run Reasoner Test Provider when enabled.
- Verify provider test activity appears in the Activity Ribbon.
- Verify model, lane, status, duration, and redacted error category appear in diagnostics.

Provider tests must not persist API keys, raw prompts, or raw responses.

### 5. Observe Pass

In Observe mode:

- Capture a turn snapshot or current chat snapshot.
- Ask runtime for a preview-safe decision when supported.
- Verify no prompt packet is installed.
- Verify Activity and Full Viewer show sanitized snapshot/card-plan metadata.

Observe mode may record hashes, counts, ids, and bounded labels. It must not create model-facing prompt keys.

### 6. Auto Utility Pass

With live generation enabled:

- Set Auto mode.
- Send a safe, short user message through the SillyTavern chat UI.
- Wait for Recursion foreground activity to start.
- Verify Utility Arbiter, card refresh, hand selection, composition, and prompt install stages appear.
- Verify the prompt packet metadata references the active snapshot id.
- Verify the Last Hand dropdown lists used card families.
- Wait for host generation to continue or complete.
- Verify the prompt packet can be cleared after the run.

The smoke should fail if Recursion blocks generation indefinitely, injects stale packet metadata, stores raw model I/O, or leaves prompt keys active after cleanup.

### 7. Reasoner Pass Or Fallback

When Reasoner smoke is enabled:

- Force or configure a Reasoner composer attempt.
- Verify Reasoner activity appears with a bounded trigger reason.
- Verify the final prompt packet stays within the prompt packet schema.
- Simulate or trigger one Reasoner failure path.
- Verify Utility or local composition fallback is visible and generation continues.

Reasoner output must not add unsupported lore, hidden story plans, private thoughts, or unbounded detail.

### 8. Failure And Cleanup

The runner should exercise at least one controlled failure path:

- invalid provider response;
- provider timeout;
- injection failure from a fake adapter path;
- storage write failure in a fake host or guarded live path.

Live destructive failure simulation should stay narrow and Recursion-owned. The cleanup stage should:

- clear prompt keys;
- close the viewer;
- return mode to the configured initial mode or Off;
- delete storage probes;
- write final artifacts;
- record whether warnings were promoted to failures.

## Expected Activity Ribbon Evidence

A passing generation-enabled run should show stages equivalent to:

```text
Snapshot captured
Utility planning
Scene cache opened
Cards refreshed
Hand selected
Composing prompt
Prompt installed
Generation continuing
Recursion ready
```

Fallback examples:

```text
Reasoner unavailable, using Utility composer
Utility response invalid, using cached hand
Prompt packet over budget, omitted low-priority cards
Storage slow, continuing with memory cache
```

Activity text must be user-facing, bounded, and free of raw prompts, raw responses, secrets, private notes, or full transcript text.

## Prompt Packet Proof

Live smoke should not store the full prompt body by default. It should record:

- prompt packet id;
- snapshot id;
- scene key hash;
- selected card ids and families;
- footprint;
- token estimate;
- prompt packet hash;
- install key;
- install status;
- clear status;
- omission reasons.

Optional debug export may include bounded excerpts only after an explicit user action. Normal smoke artifacts should rely on hashes and metadata.

## Stop Conditions

The runner should stop immediately on:

- unsafe user;
- missing or unreachable SillyTavern host;
- failed authentication;
- failed storage isolation;
- served-extension mismatch in strict mode;
- Recursion Bar not found;
- prompt cleanup failure after a prompt was installed;
- raw secret detected in any report payload;
- raw provider prompt or response detected in a normal artifact.

In non-strict mode, stale extension and optional provider unavailability may produce warnings, but the report must not call those checks passed.

## Manual Review

After a live smoke, the reviewer should inspect:

- `summary.md` for final status and warnings;
- `report.json` for scenario results and environment classification;
- Activity screenshots for visible progress and no UI overlap;
- prompt packet metadata for current snapshot and clear status;
- run journal excerpt for redaction and useful diagnostics;
- storage probe evidence for dedicated-user isolation;
- Playwright trace when an interaction failed.

Manual review should not be required for every local iteration. It is most useful before release checkpoints or after a smoke failure that cannot be reproduced through a contract test.

## Scope Boundary

This plan intentionally avoids long-form roleplay quality scoring. Recursion's live smoke asks whether the prompt compiler operates correctly in the host. It does not certify that a whole story arc remains coherent over dozens of turns.
