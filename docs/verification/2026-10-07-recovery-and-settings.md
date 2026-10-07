# Recovery and settings verification — 2026-10-07

Branch: `codex/recovery-settings`. Base: `81627ab3054265d0e55d76c519f94ef88412baf5`.

The [design](../superpowers/specs/2026-10-07-recovery-and-settings-design.md) and [implementation plan](../superpowers/plans/2026-10-07-recovery-and-settings.md) cover the approved work. The design and plan were committed before implementation as `c548d7a0`. Implementation was developed in an isolated managed worktree; the original checkout remains unchanged.

## Implemented behavior

| Problem | Result | Behavioral evidence |
| --- | --- | --- |
| Broken or ambiguous JSON | Bounded, string-aware parsing rejects duplicate decoded keys and competing roots. The canonical emitted schema drives local structural checks with at most eight safe field issues. | Parser, output-contract, output-recovery and payload-normalization scripts |
| Long or truncated Fused bundles | Complete, eligible, grounded siblings survive before diagnostic truncation; only unresolved families enter individual repair. An incomplete item is never completed by guessing. | Provider-output-recovery and durable-card-recovery scripts |
| Invented or partially dropped source evidence | Missing, malformed, unsafe-integer and out-of-window evidence rejects the card. References are never replaced with the latest message. | Evidence-recovery and card scripts |
| Ineffective or growing corrections | Each correction preserves the original source/messages, replaces feedback, retains effective capacity/format changes, and adds fixed field or semantic hints. An unchanged actual dispatch stops before another model call. | Correction-request, request-payload, attempt-policy and Guidance scripts |
| Different failure causes treated alike | Rate limits and transient transport failures have separate bounded backoff with positive jitter. Definitive native incompatibility may change Auto; forced Native remains explicit. Invalid schemas remain request failures. Context/token recovery respects output floors/ceilings and the shared operation allowance. | Provider-errors, attempt-policy, operation-budget, scheduler and durable recovery scripts |
| Every missing generated card blocking narration | Exhausted optional work may produce a smaller grounded hand with amber status. Selected constraints and forced Manual/Priority/Refinement coverage still block installation; downstream loss of a successful planned card also blocks. | Durable-card-recovery, plan-coverage, budget-parity and runtime lifecycle scripts |
| Qualification surviving profile edits | Checks bind Recursion configuration and the actual profile identity. Same-ID model/API/completion/preset/instruct changes invalidate qualification; Auto and concurrency become conservative. Open Providers displays refresh without destroying drafts. In-flight drift cannot save a test result. | Profile-identity, capability, client and rendered UI scripts |
| Confusing card settings | One `cardsPerTurn` setting, default 6 and range 0–20, independently controls the target. Manual projects the saved deck each turn without mutating it. Reasoning describes routing; Guidance strength/detail describe their own effects. Compatibility and tuning remain mounted behind a disclosure. | Card-target, settings, selection, UI/provider-panel and synthetic browser proof |
| Recovery outcomes hard to inspect | Fixed bounded counters record actual attempts, salvage, repair, omissions and required blocks. Safe causes and field issues survive checkpoint normalization and diagnostics export; raw rejected output does not. | Diagnostics, execution-contracts and execution-privacy scripts |

Processing bounds are 262,144 characters, nesting depth 64, 40 complete bundle items, eight field issues and 160-character issue paths. No runtime dependency was added.

## Verification

The pristine original checkout passed all **110** offline scripts before implementation. The installed-copy test needed permission for child Node processes; its restricted-shell failure was environmental and the same check passed with that permission.

| Command/check | Final result |
| --- | --- |
| Changed focused suites, one regression at a time | PASS; expected RED was observed before the corresponding production fixes |
| Changed-module `node --check` | PASS, all 91 changed JavaScript files |
| `npm.cmd test` | PASS, all 118 offline scripts |
| `npm.cmd run test:alpha` | PASS, 118 offline scripts and Playwright readiness |
| `npm.cmd run test:browser` | PASS, all four Playwright-dependent scripts |
| `node tools/scripts/prove-card-selection-settings-ui.mjs` | PASS at 1360×820 and 390×844 after the final UI fix |
| Maintained documentation link check | PASS, 325 local links across 45 maintained Markdown files |
| `git diff --check` | PASS before final delivery |

The settings proof uses production UI modules on an isolated synthetic host. It verifies target autosave, visible help with tooltips off, keyboard disclosure operation, disclosure persistence across autosave/tab changes, and no horizontal overflow. Its six inspected screenshots and machine report are under `artifacts/card-selection-settings/`. Browser-only Manual proof records target 2, three saved enabled families, two installed covered families, and unchanged saved selection.

Existing fixtures were updated in place for the new V1 contracts: structured mocks echo the snapshot identity, required-failure scenarios explicitly select required work, optional-failure scenarios permit a smaller hand, and correction tests expect safe fixed feedback rather than arbitrary provider prose. Internal model plan `budgets.maxCards` remains an execution budget; persisted operator Min/Max settings are removed.

## Independent review

Separate reviewers examined output parsing/contracts and the integrated recovery/settings branch. Material findings were fixed and independently rechecked:

- Preserve curly quotation marks inside valid JSON string content.
- Reject mixed valid/unsafe-integer evidence without dropping the bad reference.
- Stop metadata-only corrections that do not change the actual transport payload.
- Avoid a false native downgrade after Auto already attempted Prompt JSON.
- Preserve the original safe parse cause and actual salvage counters.
- Compare clamped output budgets when deciding whether a correction changes a dispatch.
- Refresh mounted provider checks after profile drift.
- Record optional-only Fused refusal omissions with their fixed cause.

The final classifier delta was also independently reviewed: malformed native schemas stop; genuine unsupported-format errors retain the intended Auto/forced-Native behavior. No material production issue remains in the reviewed scope. Review and command logs are retained locally under `.superpowers/sdd/2026-10-07-recovery-and-settings/`.

## Implementation decisions and limits

Corrections share the same message normalization and effective output-budget calculation as the host. Trusted non-enumerable Post-process context is preserved for local validation without becoming transport or diagnostics content. Effective Auto format is resolved against live qualification at dispatch rather than stamped onto a stage before a possible profile edit.

Implementation is committed after integrated verification because source, schema, scheduler, UI and fixture contracts span multiple tasks. The design/plan commit remains separate. Current operator/architecture/design docs were updated together; historical dated decisions and benchmark evidence retain their original context.

All model responses in this verification are synthetic. No paid live provider benchmark, account edit, deployment, merge, push or publication was performed. These results establish deterministic recovery behavior and UI correctness; they do not establish a live-model failure rate or latency improvement.
