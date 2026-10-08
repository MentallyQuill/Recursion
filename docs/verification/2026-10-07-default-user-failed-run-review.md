# Default User failed-run review — 2026-10-07

## Evidence and limits

Read-only review of the local SillyTavern Default User covered all 17 retained Recursion journals and nine current run manifests, plus the previously archived September 24 failed-run manifest. The journals contain 1,043 entries dated September 17 through October 7, 2026 (UTC). All diagnostic JSON was readable. Story messages, credentials, raw model responses, and comparison prose were not needed or included here.

The rolling journal limit is 100 entries per chat. `nextIndex - retained` accounts for 2,197 earlier entries that are no longer available. Saved manifests represent the latest operation per chat, not every historical run. There are 147 retained terminal provider-call records (130 completed, 17 failed), but fewer retained starts. These counts must not be presented as a run success rate or a complete history.

A completed provider call is not proof that its content passed every downstream semantic check. Repeated card/Guidance calls and retained rejection metadata show additional corrections without a `provider.call.failed` record. Those reasons cannot always be reconstructed from the rolling journal. Three retained Post-process outcomes are one awaiting review and two applied; none records a failed outcome.

## What occurred

| Retained provider failure | Calls | Interpretation |
| --- | ---: | --- |
| Rate limited | 7 | Clustered September 25, 14:17–14:22 UTC, on the Utility lane. Upstream capacity trouble dominates this burst. |
| Aborted | 7 | Usually adjacent to host-stop events. The logs do not identify whether the user, another extension, or another host condition initiated those stops. |
| JSON parse failure | 1 | September 28, Knowledge/Secrets. A subsequent call succeeded and the prompt was installed. |
| Schema mismatch | 1 | September 25, Social Subtext. A subsequent call succeeded and the prompt was installed. |
| Generic provider failure | 1 | During the September 25 burst. The retained descriptor cannot establish the underlying cause. |

Both recorded malformed-output cases used the Reasoner lane with `z-ai/glm-5.3:thinking`. Both reported `finishReason: stop`, short visible output, and a 16,000-token allowance. There is no recorded token-exhaustion signal for either failure. The rejected output was not retained, so its exact syntax or missing schema field cannot be reconstructed.

The archived September 24 run exhausted a nine-call recovery allowance after a Fused failure cascaded into eight segmented failures. That historical failure is already documented in `docs/technical/RATE_LIMIT_RECOVERY_EVIDENCE_2026-09-24.md`; it is not an additional failure in the retained-journal counts above.

October 7 has six retained Pre-process attempts: five installed prompts with nine selected cards and no omissions; one Arbiter request was aborted after 978 ms. The next fresh attempt completed. The five completed attempts took 81–112 seconds to prepare and 103–133 seconds through the primary reply. Their provider latencies account for most preparation time. Current saved settings use High reasoning, Always Reasoner, Fused mode, and the old six-to-twelve card range; the old High midpoint explains the nine-card hands. Heavy serial model work is a plausible latency contributor, not evidence of a server hang.

Two October 7 warnings occurred after successful replies and contain `card-selection-source-stale`. The host refused to commit card-selection history under its source/identity guard. This can affect subsequent variety/cooldown history; it does not establish that prompt preparation or narration failed. A source change, swipe, missing receipt identity, or timing race cannot be distinguished from these logs alone.

Seven current manifests are stale after source/settings/context changes with their stages completed. One is paused after a September 23 host stop; one September 21 manifest is still marked running with no later retained provider result. That old record is insufficient evidence of a currently active process. The latest completed manifest was invalidated by settings changes and disabling Recursion. The current saved `enabled: false` agrees with that sequence. The 544 `prompt.cleared` entries describe cleanup/invalidation, not 544 failed runs.

## Installed implementation

The installed extension still contains the previous recovery and settings implementation, not the approved `codex/recovery-settings` changes. After normalizing line endings, 105 of 106 production files match the pre-implementation main checkout. The remaining difference is the older OpenRouter minimal-reasoning mapping in the host adapter. That mapping does not explain the recorded NanoGPT calls. The unchanged package version alone cannot identify which code revision generated a log.

No live model calls, user-setting changes, journal rewrites, or extension deployment were performed for this audit.

## Confirmed diagnostic defects and bounded design

The existing storage normalizer reproduces two misleading behaviors on both the installed implementation and the approved branch:

1. `card-selection.history-not-saved` and the four emitted `turn.timing.*` events are absent from the event allowlist. They become `activity.stage_changed`, obscuring what happened.
2. A warning with a supplied string reason is passed to `failureFrom()` with the fallback code `RECURSION_JOURNAL_REASON_MISSING`. The reason becomes its message while the misleading fallback code remains. The two source-stale warnings therefore appear to be unexplained internal errors.

The correction retains the existing bounded, sanitized journal contract. Known emitted event names survive storage and reload. A safe nonempty string in `reason`, `statusReason`, or `cautionReason` is an explanation and does not manufacture an internal failure. Explicit structured failures remain authoritative. Warnings/errors without a usable explanation still receive `RECURSION_JOURNAL_REASON_MISSING`; host-stop attribution remains explicit when unknown.

Example expected record:

```js
await repo.appendJournal('synthetic-chat', {
  event: 'card-selection.history-not-saved',
  severity: 'warn',
  summary: 'Card selection history could not be saved.',
  details: { reason: 'card-selection-source-stale' }
});
// Reload: same event and reason, no invented details.failure.
```

## Implementation plan and verification

- Add repository append/reload regressions for the source-stale warning and all four timing milestones. Observe failure before changing production code.
- Admit only the five known emitted event names. Observe that the warning still fails because an internal failure is fabricated.
- Treat safe reason strings as explanations, preserve explicit failure precedence, and test missing/empty/unsafe reasons plus redaction. Keep unknown host-stop behavior intact.
- Update the storage/diagnostics contract. Run storage, host-stop attribution, turn-timing tests, and the full offline suite. Request an independent read-only review before integration.

Broader follow-up candidates from this evidence are failure-focused retention within a fixed bound, build revision fingerprints, more precise cancellation descriptors, and source-stale receipt reproduction. These require separate behavioral design; retaining raw prompts or rejected story output is unnecessary. The approved recovery changes should be installed and measured before making claims about improved live latency or error rates.

## Verification results

- Observed RED: append/reload changed the history-warning event to `activity.stage_changed`.
- Observed RED after admitting the event: the explained warning still received a fabricated failure descriptor.
- Review added a RED for 121/501-character whitespace-only reasons. Trimming before bounds corrected that case and preserved a real explanation following 501 spaces.
- Storage, host-stop attribution, turn timing, failure reporting, diagnostics, and changed-module syntax checks passed after the final fix.
- The independent read-only reviewer rechecked the fix and found no remaining material or minor issues. Additional synthetic probes confirmed redaction of unsafe text beyond 500 characters, caller-input immutability, and unchanged unknown host-stop attribution.
- The full offline suite passed all 118 scripts after the final whitespace fix. The integrated result is verified separately before pushing.

The broader recovery/settings implementation's browser and UI proof results are recorded in [its verification report](2026-10-07-recovery-and-settings.md). This follow-up changes journal metadata only and makes no live recovery-rate claim.
