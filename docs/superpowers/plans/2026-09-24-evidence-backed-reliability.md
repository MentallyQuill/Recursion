# Evidence-backed reliability implementation plan

> Execute inline using executing-plans and test-driven-development; review the whole branch before integration.

**Goal:** Address the approved chat diagnostic findings without adding successful-path model calls, then verify and push to main.

**Spec:** Approved in-chat design and active goal: Guidance verification/recovery, typed omissions, truthful failures, and available primary-generation timing boundaries.

**Architecture:** Preserve the existing scheduler, provider custody, frozen-turn provenance, and required Guidance contract. Fix data shapes at their persistence/export boundaries. Record observable host milestones without claiming network dispatch or provider latency when the host does not expose them.

**Constraints:** Preserve unrelated work and live host data. No speculative retry/concurrency changes. No invented Guidance or conflicting identity repair. No full provider response or conversation text in diagnostics.

## Tasks

- [x] 1. Add a regression reproducing omission object corruption across composition, Last Brief save/reload, and diagnostics. Preserve validated `{ id, reason }` records and distinguish Guidance omissions from hand omissions. Run diagnostics, Last Brief, and prompt checks.
- [x] 2. Add a journal regression for unknown host stops. Preserve unknown cause explicitly, keep real supplied errors, and avoid synthesizing an internal failure for normal cancellation. Run storage and host/runtime stop checks.
- [x] 3. Verify the Guidance contract through the real host adapter with controlled provider responses. Add compact structural failure metadata and actionable correction feedback only where missing. Verify existing fail-closed and checkpoint-only retry coverage. Run provider, host, Guidance, and runtime preprocess checks.
- [x] 4. Trace installed host event definitions read-only. Add available request-ready/stream milestones and derived durations with null for unavailable boundaries. Test invalidation, duplicates, empty/internal events, and completion without streaming. Document the observed delay without inferring its cause.
- [x] 5. Update contracts and evidence report. Run full offline suite, alpha gate and applicable browser checks; review scoped diff and reconcile current main.

**Release requirement:** Push the verified commit to main and confirm the remote SHA before completing the active goal. Record remote confirmation in the goal completion response.

## Review focus

Malformed omission objects must never become fake IDs; valid reasons must survive reload. Unknown stops must not erase genuine errors. Guidance envelope completion must not repair conflicting identities. Timing callbacks must not attribute stale/internal events to a newer turn. Diagnostics must exclude provider prose and credentials.

## Execution ledger

- Baseline: isolated native worktree, branch `codex/evidence-backed-reliability`, based on `01a2d63f` matching origin/main. Initial suite stopped because Playwright was not installed; installed lockfile dependencies with `npm ci --ignore-scripts` before retrying.
- Ruling: execute the approved bounded design without another approval loop; all implementation and push are explicitly authorized by the active goal.

- Implementation and independent review complete. Rebased cleanly onto main at `95581234`. The final alpha gate passed with 86 offline scripts, documentation checks and Playwright readiness; all three browser scripts passed again after the rebase. The scoped diff passed whitespace checks.
