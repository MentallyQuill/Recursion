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

Refactor hotspot audit:

```powershell
node tools\scripts\audit-refactor-hotspots.mjs
```

This static guard checks that the major refactor boundaries remain in place: guidance activity lane support, provider core host neutrality, explicit runtime helper modules, pipeline modules, and UI/provider presenter modules.

## Current Guardrail Commands

The commands in this section prove safety gates, report shape, offline Playwright readiness, dedicated-user storage probes, served-extension freshness, no-generation Recursion UI smoke, and opt-in generation evidence when the required flags and providers are configured. They do not contact SillyTavern unless a live script is run with `--live`. Live scripts reject unsafe users before mutation.

Offline Playwright readiness:

```powershell
node tools\scripts\check-playwright-readiness.mjs --write-artifacts
```

Use `--dry-run` when you want a no-op readiness checklist without importing Playwright.

Dedicated user storage and isolation preflight:

```powershell
$env:SILLYTAVERN_BASE_URL='http://127.0.0.1:8000'
$env:RECURSION_SOAK_ST_USERS='recursion-soak-a,recursion-soak-b,recursion-soak-c'
node tools\scripts\check-sillytavern-soak-users.mjs --live --write-artifacts
```

This command logs into each dedicated user, writes one Recursion-owned probe file, verifies readback, checks that other users cannot see the probe, and deletes the probe files. If the dedicated users do not exist or credentials are wrong, it returns `environment-fail` before broader smoke runs.

No-generation live UI smoke:

```powershell
$env:SILLYTAVERN_BASE_URL='http://127.0.0.1:8000'
$env:RECURSION_SILLYTAVERN_USER='recursion-soak-a'
node tools\scripts\smoke-sillytavern-live.mjs --live --write-artifacts
```

This command authenticates the dedicated user, compares the served Recursion manifest, entrypoint, static import graph, and stylesheet against the checkout, runs the Recursion-owned storage probe, opens SillyTavern with Playwright, verifies the Recursion Bar, Hero Pixel Array progress menu, Last Brief dropdown, settings/options menu, Full Viewer access, and bridge hooks, then writes screenshots, trace, live log, served-extension comparison, storage probe, browser snapshot, summary, and report artifacts. It does not send chat messages or call providers.

Live swipe smoke:

```powershell
$env:SILLYTAVERN_BASE_URL='http://127.0.0.1:8000'
$env:RECURSION_SILLYTAVERN_USER='recursion-soak-a'
$env:RECURSION_LIVE_SWIPE='1'
node tools\scripts\smoke-sillytavern-live.mjs --live --write-artifacts
```

The older-message swipe smoke remains a temporary in-page mutation and proves
source invalidation. That evidence is synthetic and must be labeled as such.
Prepared-generation certification is a separate strict native-host proof:
`prove-live-swipe-reuse.mjs --live` must use the installed extension runtime,
visible SillyTavern latest-assistant swipe control, real event/interceptor
routing, and configured provider/host generation path. It must not construct a
fake runtime or provider router in the page. The report proves the installed
and served hashes, stable packet/artifact identity, no additional Recursion
provider calls or storage writes on the swipe, prompt reinstallation, native
story continuation, compact cached feedback, and unchanged pre-assistant chat
shape. If any native evidence is unavailable, strict proof fails rather than
falling back to the synthetic served-module check.

Before any served Playwright proof, synchronize and hash-check the complete extension directory that backs `/scripts/extensions/third-party/Recursion`. Updating only a profile data copy or selected source modules is not sufficient evidence: SillyTavern may continue serving stale transitive modules such as `cards.mjs`.

Generation-enabled Utility smoke target:

```powershell
$env:SILLYTAVERN_BASE_URL='http://127.0.0.1:8000'
$env:RECURSION_SILLYTAVERN_USER='recursion-soak-a'
$env:RECURSION_LIVE_GENERATION='1'
node tools\scripts\smoke-sillytavern-live.mjs --live --write-artifacts --strict
```

Reasoner-capable smoke target:

```powershell
$env:SILLYTAVERN_BASE_URL='http://127.0.0.1:8000'
$env:RECURSION_SILLYTAVERN_USER='recursion-soak-b'
$env:RECURSION_LIVE_GENERATION='1'
$env:RECURSION_LIVE_REASONER='1'
node tools\scripts\smoke-sillytavern-live.mjs --live --write-artifacts --strict
```

Generation-enabled Utility and Reasoner smoke are opt-in. Setting `RECURSION_LIVE_GENERATION=1` or `RECURSION_LIVE_REASONER=1` runs the safe preflight and UI evidence, switches Recursion to Auto, wraps `setExtensionPrompt` to record only prompt-key metadata, sends the safe smoke message through visible SillyTavern send controls when both input and send button are available and enabled, and verifies prompt install, hand readiness, host generation continuation, prompt cleanup, and prompt-packet metadata. If no visible send controls are available, non-strict runs may use the public generation bridge as a diagnostic fallback, but they must record the trigger source as `direct-bridge` and must not claim host generation continuation. Strict generation runs reject that fallback with `generation-direct-bridge-diagnostic`; release proof requires visible send controls. Partial or disabled visible send surfaces fail instead of falling back. Generation-enabled runs suppress screenshots and Playwright traces because binary artifacts can capture chat or provider text. The default browser smoke stays no-generation. Both paths must stay dedicated-user-only and must reject unsafe users before login, browser navigation, storage probes, chat mutation, prompt injection, or provider calls.

Live Editorial Enhancement proofs use `tools/scripts/lib/live-enhancement-run-oracle.mjs` as their sole health verdict. Before each generation or direct Enhancement case, the proof captures the current journal entry IDs and installs a `MutationObserver` that records every progress-row state, including rows later removed or replaced. After settlement, the oracle compares the journal delta, verifies every provider start settled, rejects all caution/warning/failed/skipped observations, and requires final done states for Editorial diagnosis, Editorial candidate, and Recursion prompt ready. It also requires a validated `recursion.editorialMarker.v1` on a Recursion-owned swipe or replacement. A proof must set a nonzero exit code whenever this oracle is unhealthy, regardless of any later green tree or otherwise successful behavior assertion.

## Scenario Matrix

| Scenario | Mutates chat | Requires provider | Must prove |
| --- | --- | --- | --- |
| Mount smoke | no | no | Recursion extension loads, Recursion Bar renders, Hero Pixel Array progress menu can open, settings/options can open, viewer can open. |
| Pipeline smoke | no | no | Pipeline button appears immediately left of Mode, opens the Standard/Rapid/Fused menu, persists selected pipeline mode, and does not duplicate Pipeline controls in Settings. |
| Mode smoke | no | no | Disabled power, Auto, Manual, and return-to-disabled controls update runtime state, clear Recursion prompt keys, and record sanitized `modeSmoke` proof. |
| Swipe smoke | temporary in-page only | no | Older-message `MESSAGE_SWIPED` clears Recursion prompts, changes active source revision A -> B, and returns to the same A revision on swipe back; deterministic latest-assistant retry tests prove no clear, no Rapid warm, and same-packet reinstall. |
| Storage probe | files only | no | Dedicated user can write/read/delete Recursion-owned files and records are isolated from other users. |
| Manual smoke | optional | Utility | Manual applies as a distinct mode, blocks over-cap family selection, forces selected family coverage, installs prompts, and records sanitized proof for the Manual branch. |
| Utility provider smoke | yes | Utility | Arbiter/card/composer work runs, progress menu reports it, prompt packet installs, and generation continues. |
| Reasoner fallback smoke | yes | Utility and Reasoner | Reasoner can compose when healthy and falls back to Utility when off, timed out, or invalid. |
| Prompt cleanup smoke | no | no | Power-off, disable, teardown, and chat change clear Recursion prompt keys. |
| Failure smoke | optional | simulated or real failing lane | Provider/storage/injection failure reports visible fallback and does not block host generation. |
| Responsive UI smoke | no | no | Desktop and phone viewport screenshots show no overlap with chat controls. |

## Detailed Flow

The live runner should execute these stages in order.

### 1. Preflight

- Validate environment variables.
- Reject unsafe users.
- Authenticate when needed.
- Compare served extension manifest, entrypoint, static import graph, and stylesheet to the checkout.
- Run storage probe.
- Open SillyTavern with Playwright.
- Capture baseline console and page-error state.

The run stops here on unsafe user, stale extension, missing host, failed auth, or failed storage isolation.

### 2. Mount And UI

- Locate the Recursion Bar.
- Assert the compact bar has stable power, mode, progress, reasoning, Last Brief, and options zones.
- Open the Hero Pixel Array progress menu.
- Open the Last Brief dropdown.
- Open settings/options and verify Play, Providers, and Advanced tabs.
- Open Full Viewer from settings/options.
- Visit Now, Deck, Activity, Prompt Packet, Settings, and Providers views when viewer is open.
- Capture desktop screenshot.
- Capture phone viewport screenshot.

The smoke should fail if controls overlap chat input, if text escapes compact controls, or if the progress menu cannot render a clear status.

### 3. Mode Transitions

- Seed a Recursion-owned prompt key as a cleanup sentinel.
- Turn power off and verify prompt keys are absent or cleared.
- Open the Pipeline menu and verify Standard, Rapid, and Fused choices are present, selectable, and persisted through `pipelineMode`.
- Set Auto mode and verify the runtime is ready to compile when a generation begins.
- Set Manual mode and verify it applies as a distinct mode.
- Return to power off and verify cleanup.

Pipeline, mode, and power changes should be visible in the bar and should append sanitized activity events. The no-generation browser snapshot should include `modeSmoke.sequence: ["disabled", "auto", "manual", "disabled"]`, per-step selected/observed modes, selected/observed pipeline modes, power state, and prompt-key names only. It must not store seeded prompt text.

### 4. Provider Controls

When providers are configured:

- Run Utility Test Provider.
- Run Reasoner Test Provider when the Reasoner route is configured.
- While Reasoner is expanded, change a committed provider field and verify the Reasoner Provider section stays expanded after autosave.
- Verify the clicked Test Provider button changes to `Testing...`, disables while pending, and the settings panel remains responsive.
- Verify provider test activity appears in the progress menu or Full Viewer Activity section.
- Verify model, lane, status, duration, and redacted error category appear in diagnostics.

Provider tests must not persist API keys, raw prompts, or raw responses. They use the lane's configured max-token ceiling, default `8192`, with a bounded timeout and strict structured health response.

### 5. Manual Pass

In Manual mode:

- Capture a turn snapshot or current chat snapshot.
- Verify the mode applies as `manual`.
- Set `Max Cards` to a small value such as `2`, select two family rows, attempt a third, and verify the visible cap notice names Max Cards.
- Run a Manual generation where the Arbiter omits one selected family; verify runtime covers the selected family through valid cache reuse or a synthesized card job.
- Verify a prompt packet is installed through the Manual branch.
- Verify the progress menu and Full Viewer show sanitized snapshot/card-plan metadata.

Manual mode may record hashes, counts, ids, selected family keys, cap-block status, forced-family keys, omitted family keys, and bounded labels. It must not leak raw provider payloads, prompt text, full transcript text, or secrets.

### 6. Auto Utility Pass

With live generation enabled:

- Set Auto mode.
- Send a safe, short smoke message through visible SillyTavern chat controls when they are present.
- If no visible send controls are available, record that the run used the public generation bridge diagnostic fallback instead of user-visible send evidence.
- If only one visible send control is available, or visible controls are disabled, fail the run instead of masking a broken chat surface with the direct bridge.
- Wait for Recursion foreground activity to start.
- Verify Utility Arbiter, card refresh, hand selection, composition, and prompt install stages appear.
- Verify the prompt packet metadata references the active snapshot id.
- Verify the Last Brief dropdown lists used card families.
- Verify prompt-install evidence through Recursion-owned prompt keys, hashes, lengths, and placement metadata. Do not store raw prompt text.
- Wait for host generation to continue or complete when using the full chat UI path.
- Verify the prompt packet can be cleared after the run.
- Do not write screenshots or Playwright trace artifacts for generation-enabled runs.

The smoke should fail if Recursion blocks generation indefinitely, injects stale packet metadata, stores raw model I/O, or leaves prompt keys active after cleanup.

### 7. Reasoner Pass Or Fallback

When Reasoner smoke is enabled:

- Force or configure a Reasoner composer attempt.
- Verify Reasoner activity appears with a bounded trigger reason.
- Verify the final prompt packet stays within the prompt packet schema.
- Simulate or trigger one Reasoner failure path.
- Verify Guidance or Reasoner fallback is visible, generation continues, and sanitized prompt metadata records `composerLane`, `guidanceStatus`, and `reasonerStatus` without raw provider failure text.

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

## Expected Progress Evidence

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
Reasoner unavailable, using Guidance composer
Utility response invalid, using cached hand
Prompt packet over budget, omitted low-priority cards
Storage slow, continuing with memory cache
```

Progress text must be user-facing, bounded, and free of raw prompts, raw responses, secrets, private notes, or full transcript text.

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

Normal smoke artifacts should rely on hashes and metadata. Bounded excerpts require an explicit user action and redaction.

## Stop Conditions

The runner should stop immediately on:

- unsafe user;
- missing or unreachable SillyTavern host;
- failed authentication;
- served-extension mismatch or unavailable served Recursion files;
- failed storage isolation;
- Recursion Bar not found;
- prompt cleanup failure after a prompt was installed;
- raw secret detected in any report payload;
- raw provider prompt or response detected in a normal artifact.

In non-strict mode, optional provider unavailability may produce warnings, but stale or unavailable served Recursion files remain blocking and must not run the storage probe or browser smoke.

## Manual Review

After a live smoke, the reviewer should inspect:

- `summary.md` for final status and warnings;
- `report.json` for scenario results and environment classification;
- no-generation Activity screenshots for visible progress and no UI overlap;
- prompt packet metadata for current snapshot and clear status;
- run journal excerpt for redaction and useful diagnostics;
- storage probe evidence for dedicated-user isolation;
- Playwright trace for readiness and no-generation interaction failures only.

Manual review should not be required for every local iteration. It is most useful before release checkpoints or after a smoke failure that cannot be reproduced through a contract test.

Reviewed no-generation screenshots may become documentation render sources only after redaction review and promotion through [Documentation Render Tracking](DOCUMENTATION_RENDER_TRACKING.md). Raw live smoke artifacts remain local evidence under `artifacts/`.

## Scope Boundary

This plan intentionally avoids long-form roleplay quality scoring. Recursion's live smoke asks whether the prompt compiler operates correctly in the host. It does not certify that a whole story arc remains coherent over dozens of turns.
