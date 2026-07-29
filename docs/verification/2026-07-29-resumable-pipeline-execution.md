# Resumable Pipeline Execution Verification

- Date: 2026-07-29
- Branch: `codex/resumable-pipeline-execution`
- Source commit: `75dfd6e0`
- Installed profile: `recursion-soak-a`
- Installed extension: `F:\SillyTavern\SillyTavern\data\recursion-soak-a\extensions\Recursion`
- Live report: `artifacts/live-resumable-pipeline/resumable-pipeline-proof-ms64tc9b-opkyjc/report.json`
- Provider: deterministic in-page fixture; no external model calls

## Automated Verification

- Focused resumable-execution matrix: passed 16 scripts, including scheduler,
  storage, privacy, Segmented/Fused, Pre-process, Post-process, progress,
  settings, and UI coverage.
- Full `npm.cmd test`: passed all 54 test scripts.
- `npm.cmd run test:alpha`: passed all 54 test scripts, the current
  documentation contract, Playwright readiness, and the Recursion alpha gate.
- `node tools/scripts/audit-refactor-hotspots.mjs`: passed.
- Timeout/attempt-shim scan: no hard-coded 120-second provider timeout or
  retired recovery-attempt shim found in active source.
- Retired-term scan: active runtime and UI use Segmented, Fused, and Queued.
  Remaining broad-scan matches are historical plans/reports, generic card
  detail-profile values, and explicit invalid-value or negative tests.
- `git diff --check`: passed.
- Installed-copy verifier: installed copy matches all 77 production files.

## Live SillyTavern Scenarios

The proof loaded the production-only installed extension through the dedicated
`recursion-soak-a` SillyTavern profile and exercised the real browser runtime
and progress DOM.

- Segmented Stop paused the active card stage while retaining the completed
  Arbiter and completed sibling card.
- Extension lifecycle recreation restored the paused manifest without opening
  provider work.
- Resume reused the Arbiter and sibling checkpoints and reran only the
  interrupted card.
- Queued Reprocess opened no immediate call and was consumed by the next
  preparation.
- A failed guidance stage used the configured two attempts, paused, and Retry
  reran only that stage.
- Cancel removed the queued reprocess intent without changing completed work.
- Reprocess full reran the entire graph once.
- Fused retained useful partial output.
- Zero-useful Fused output exhausted its two bundle attempts, fell back to one
  Segmented wave, and reused the Arbiter checkpoint.
- Prompt-install failure remained fail-soft: primary generation was allowed to
  continue and the failed install stage remained visible.
- Unified Post-process retained completed guidance across Stop/recreation,
  reran only the interrupted rewrite, and committed once.
- Progressive Post-process retained the completed first-category draft and
  both guidance checkpoints, reran only the interrupted second-category
  rewrite, and committed once.
- Repeating Resume after completion did not duplicate the host commit.
- Reset removed the execution manifest and queued intent.
- Desktop and 390-pixel mobile progress views rendered no horizontal overflow,
  no more than one contextual action per row, 24-by-24-pixel action slots, and
  accessible labels/tooltips.

## Defect Found During Certification

The first zero-useful Fused live proof exposed a scheduler race: a concurrent
sibling could finish while another sibling awaited a repository read, causing
the later sibling to reject its own harmless stale pre-commit read and remain
stranded in `running`.

The scheduler now uses operation, stage state, and execution token for the
pre-commit liveness check. Revision enforcement remains inside the serialized
mutation queue, where a real conflicting revision still fails safely. A
regression test forces the stale sibling read and proves both siblings commit.

## Known Limits

- The deterministic fixture verifies Recursion orchestration without incurring
  provider cost or depending on provider availability; it does not certify a
  particular external provider's transport or latency behavior.
- The installed Pre-process proof used the dedicated profile's real Recursion
  storage path. Post-process recreation used the installed browser modules with
  an isolated in-page repository so host mutation counts could be asserted
  deterministically.
- "Reload" in this proof is extension lifecycle disable/enable plus runtime
  recreation within the loaded SillyTavern page, not a browser-process restart.
