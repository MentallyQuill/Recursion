# Turn-Scoped Reuse and Host-Owned Resume Verification

- Date: 2026-08-01
- Branch: `refactor`
- Source implementation commits: `d6512855`, `aae576b7`
- Installed SillyTavern user: `default-user`
- Installed extension: `F:\SillyTavern\SillyTavern\data\default-user\extensions\Recursion-refactor`
- Served extension: `F:\SillyTavern\SillyTavern\public\scripts\extensions\third-party\Recursion-refactor`
- Deterministic report: `artifacts/live-resumable-pipeline/resumable-pipeline-proof-msaqn97h-ceujl6/report.json`

## Connection Profiles

The final Writer and SG-1 acceptance runs used the requested host connection
profiles from `default-user/settings.json`:

- SillyTavern: `nanogpt zai-org/glm-5.2:thinking - Celia V5.4`
  (`12702d3f-37e0-4b8a-898d-7c7fe234b45d`).
- Recursion Utility: `nanogpt nvidia/nemotron-3-ultra-550b-a55b:thinking - Provider`
  (`5624d797-416a-4f51-be2c-45f95cd3463c`).
- Recursion Reasoning: `nanogpt deepseek/deepseek-v4-flash-0731:thinking - Celia V5.4`
  (`5a2706b7-b7e1-4d13-9701-3fee8c50eb49`).

Reasoning level remained Low, so the Utility lane was exercised and the
configured Reasoning profile remained assigned but unused, as designed.

## Automated Verification

- Focused runtime ownership regression: `node tools/scripts/test-runtime-preprocess.mjs` passed.
- Focused running-action precedence regressions:
  `test-progress.mjs`, `test-ui-render.mjs`, and `test-ui.mjs` passed.
- Full `npm.cmd test` passed all 56 test scripts after each final source fix.
- Final `npm.cmd run test:alpha` passed all 56 test scripts, the current
  documentation contract, Playwright readiness, and the Recursion alpha gate.
- Deterministic served-module proof passed as
  `live-resumable-pipeline-pass`. It proves zero Recursion model calls on an
  unchanged swipe, packet reinstall, edited-band invalidation, queued stage and
  full-fresh execution, Stop, host-owned Resume, and Post-process identity
  replacement.
- Both `recursion-soak-a` and `default-user/Recursion-refactor` installed/public
  surfaces matched all 79 production files byte-for-byte after restoration of
  the temporary live-test manifest override.

## Writer Live Acceptance

Chat: `Writer - 2026-02-12@18h42m54s853ms - Branch #1`.

- A fresh operation completed and installed its prompt for the active source
  band.
- An immediate unchanged native swipe reused the same operation, turn key, and
  source-band hash.
- The execution journal remained at index 351 with a delta of zero provider
  events while the prompt was reinstalled.
- SillyTavern generated and saved a distinct GLM 5.2 swipe.

This proves same-turn swipe reuse is tied to source identity rather than the
generated assistant response or an elapsed-time scene cache.

## SG-1 Live Acceptance

Chat: `SG-1 - 2025-11-17@15h46m05s - Branch #2`.

- Native swipe recovered the previously stranded empty assistant row and ran a
  complete Recursion operation before host generation.
- A subsequent real user message created a distinct turn key and operation;
  Utility planning ran again instead of skipping directly to SillyTavern.
- The earlier broken Resume had left SillyTavern at an impossible `3/2` swipe
  cursor. Selecting the prior valid native swipe restored `2/2`; later
  generation completed at valid `4/4` and `5/5` positions.
- A completed `4/4` checkpoint queued Planning Card Pass for the next native
  swipe. While the stage was running, the row exposed `Stop and pause this
  operation` and did not expose `Cancel queued reprocess`.
- Stop paused Recursion, hid SillyTavern Stop, left the send box available, and
  exposed `Resume from saved checkpoint`.
- Resume re-entered SillyTavern as a native swipe, showed SillyTavern Stop, and
  continued from the saved Reasoner-guidance frontier rather than creating a
  new normal operation or restarting Planning Card Pass.
- The resumed pipeline completed, installed its prompt, and produced swipe
  `5/5` through `nanogpt - zai-org/glm-5.2:thinking` in 40.897 seconds.

## Defects Found During Live Certification

1. A queued reprocess restored transient context with the current swipe type
   but retained the completed manifest's prior `normal` generation type. Stop
   therefore saved a paused run that Resume restarted as a new normal host
   operation. The manifest now adopts the current host-owned native action
   before queued work can start or pause.
2. A queued running frontier displayed Cancel before Stop because queued-action
   detection preceded running-frontier detection. Running work now owns Stop;
   Cancel remains available only while the work is still queued.

## Storage and Test-Environment Notes

- SillyTavern currently discovers both the historical `Recursion` public copy
  and `Recursion-refactor`. During live acceptance only, the disabled duplicate
  interceptor entry was neutralized with a temporary manifest override before
  page load so one runtime owned each host generation. Both manifests were
  restored byte-for-byte afterward, and the final installed-copy verifiers
  passed.
- The earlier storage inventory found 126 unindexed physical V1 generated
  records (16 scene, 2 run, 108 artifact, 0 queue). They are inert under the V2
  indexes and runtime contracts. They were not deleted because removing
  unindexed user-profile files requires explicit authorization.
