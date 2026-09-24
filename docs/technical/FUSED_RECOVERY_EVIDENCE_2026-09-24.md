# Fused recovery evidence

## Observed defects

The supplied diagnostic export showed completed prompt preparation with a Fused bundle followed by one Character Motivation repair. The original rejection cause was unavailable: validation collapsed missing, duplicate, and semantic failures to `invalid-card`, and export omitted family outcomes. Replaying the state through the installed progress projection produced a failed Fused parent/child and a fabricated internal-error explanation despite successful repair.

A separate host-boundary probe established that Fused requests kept source instructions in local metadata but sent only source-card names. Individual-card requests included their instructions.

## Changes and proof

| Requirement | Evidence |
| --- | --- |
| Full source IDs and sanitized instructions reach the model | `test-fused-recovery.mjs` captures the real host adapter's Connection Manager messages and checks instruction text longer than 1000 characters. It failed before the request change. |
| Precise, private per-family rejection records | The same test covers missing, duplicate, malformed, normalized provider rejection, private-claim and hidden-content cases, plus pending summaries and a provider-text canary in export. |
| Persistence and targeted correction | `test-runtime-preprocess.mjs` saves/reloads original rejection records, exports them, checks the first repair prompt's reason, and verifies accepted siblings are not regenerated. |
| Truthful progress | `test-fused-progress.mjs` covers active/reloaded graph state, pending/running/completed/failed/skipped repair, the gap before repair dispatch, and retries in both bundle and individual repair. |
| Real rendered UI | `prove-fused-recovery-ui.mjs` loads production UI and CSS in an isolated Chromium fixture. It checks repairing/recovered row states, readable original rejection details, and reload. Screenshots are saved under `artifacts/fused-recovery-ui`. No live host is modified. |
| Checkpoint invalidation | Fused stage version 2 invalidates checkpoints created without the new request/diagnostic contract. |

Red-to-green tests reproduced the request omission, lost rejection summary, missing correction feedback, red recovered rows, hidden recovered details, pending export crash, and retry-induced amber recovery. Independent review identified the retry normalization edge; both Fused and individual repair rows now preserve successful recovery while retaining attempt counts.

## Integration boundary

This change is based on `a473a58b`, the completed “Improve Recursion reliability” work. Its Guidance, omission, host-stop, and primary timing behavior is preserved. The shared diagnostic import conflict was resolved by keeping both helpers. No extra successful-path model calls were introduced. The final combined alpha gate passed 88 offline test scripts and Playwright readiness. All three browser fixture suite scripts and the rendered Fused recovery proof passed on the combined branch.

These checks use controlled provider responses. They establish request contents, recovery behavior, persistence, and UI projection; they do not establish a live model failure rate or identify the discarded original Character Motivation response. Live SillyTavern installation and user data were not changed.
