# Failed-run resilience, truthful status, and measurable preparation

Date: 2026-10-07. Baseline: `452f35c9a2b7534593480880f9462b513b394b85`.

## Intent and success

Make Recursion easier to recover and easier to understand when preparation is slow, a provider is rate limited, output needs correction, or generation stops. Preserve enough safe evidence to explain each operation after ordinary journal entries roll out. Correct valid card-history receipts rejected during Continue without weakening chat, branch, message, or swipe guards.

The user requested a goal covering the six recommendations, beginning with an expanded spec and implementation plan containing real problem/solution examples. Standing authorization permits implementation and pushing verified work to main without further approval requests. This design uses the existing isolated workspace and native execution with one independent review before integration.

Completion means the code, documentation, deterministic tests, compact UI proof, and installation/measurement tooling satisfy these contracts. A paid live benchmark is a separate explicitly opted-in experiment. No live error-rate or latency improvement may be claimed from synthetic responses. Default User story/settings/storage are not benchmark fixtures.

## Evidence and confidence

The [Default User audit](../../verification/2026-10-07-default-user-failed-run-review.md) reviewed 1,043 retained entries in 17 journals and nine current manifests. Another 2,197 entries had rolled out. Seven rate-limit failures clustered on September 25; seven requests were aborted with unknown initiator; both explicit JSON/schema failures recovered; one provider failure retained insufficient cause. Five October 7 preparations succeeded in 81–112 seconds, with one short cancellation. Two warnings rejected card-selection history after completed replies.

The installed copy predates the changes already on main. Main already has bounded JSON parsing, canonical field issues, effective correction detection, salvage, cause-specific retry bounds, profile-bound qualification, a six-card default, and corrected journal reason/event normalization. This project extends those mechanisms rather than creating a second parser, scheduler, or retry system.

Current code already shares cooldowns by connection profile (`src/providers/profile-request-queue.mjs`) and persists operation cooldowns in `recoveryBudget.providerCooldowns`. `restoreExecutionState()` already converts interrupted running work to paused, resets only unfinished stages, and preserves completed checkpoints. New work here exposes those facts and proves their cross-operation behavior.

Confirmed additional defects/gaps:

- The raw journal ring is the principal provider-call history. Completed stage failures are cleared, so semantic correction details can disappear.
- Package/storage version strings do not identify a production code revision. Installed-copy verification exists, but runtime reports have no build stamp.
- `providerFailure()` maps aborted requests through a generic provider-request descriptor; the activity reporter separately manufactures a missing-reason descriptor from explained warnings.
- The host combines missing receipt identity and changed source-prefix conditions under one `card-selection-source-stale` reason.
- A synthetic Continue reproduces a valid-history rejection: the preparation prefix includes the existing assistant response; commit compares the prefix before the mutable assistant target. This is a verified defect, not proof that either observed user warning came from Continue.

## Approach and alternatives

Use the existing durable manifest, storage queue, profile request queue, and compact inspectors. Add small pure normalizers for operation summaries, build metadata, wait presentation, and receipt basis. This keeps generation authority in the current scheduler and host seams.

Increasing every journal limit would retain more cleanup noise while leaving cleared semantic failures and build identity ambiguous. Replacing the scheduler with a new job framework would create unnecessary cancellation/commit risk. A focused extension of existing contracts gives each recommendation an independently testable result.

## 1. Verifiable installation and build identity

### Current problem

`src/storage.mjs` currently records only:

```js
const RECURSION_VERSION = '0.3.0-beta.1';
// baseRecord() attaches recursionVersion, regardless of the code revision.
```

`tools/scripts/verify-installed-copy.mjs` already compares executable production files. Retain that byte comparison as the installation gate. Add a deterministic production-tree identity for comparison across platform line endings, and generated installation metadata for runtime reporting.

### Contract

- `productionTreeIdentity(root)` hashes sorted relative paths and their contents, normalizing BOM/CRLF only for known UTF-8 text assets. Binary assets remain byte exact. Exclude generated `build-info.json` from the hash to avoid recursion.
- A staging command copies the production inventory into a user-named workspace output directory and writes `build-info.json` with schema `recursion.buildInfo.v1`, package version, source revision (40 lowercase hex or null), dirty flag, production SHA-256, and creation timestamp. A dirty checkout cannot be labeled as a clean committed build.
- Browser runtime loads only its own extension's build-info resource once, with no provider probes. Metadata is limited to 2,048 characters and allowlisted fields. Missing, malformed, oversized, or unavailable metadata becomes `status: unavailable`.
- Runtime reports describe valid metadata as `status: declared`. A runtime stamp alone is not proof that every served module matches it. Installed/served verification reports establish `verified` only after checking actual production contents.
- Diagnostics and retained operation summaries bind the declared build descriptor. Never label today's checkout SHA as the revision of an older installed run.
- Staging is reversible and does not read or copy user settings, secrets, chats, or journals. Installation instructions use the existing account-only verifier against the staged production root, require a reload, and preserve a production-file backup for rollback. No automatic Default User model calls accompany installation.

Example generated metadata:

```json
{"schema":"recursion.buildInfo.v1","version":"0.3.0-beta.1",
 "sourceRevision":"452f35c9a2b7534593480880f9462b513b394b85",
 "dirty":false,"productionHash":"<64 lowercase hex>","createdAt":"<ISO timestamp>"}
```

The angle-bracket values above illustrate field shape; code tests use actual hashes and fixed timestamps. No placeholder is accepted as a valid runtime hash.

## 2. Clear, bounded rate-limit waiting

### Existing solution to preserve

The real queue already owns profile capacity:

```js
function rateLimited(profileId, retryAfterMs) {
  const key = String(profileId || '').trim();
  const count = (rateLimits.get(key)?.count || 0) + 1;
  const delayMs = rateLimitDelay(retryAfterMs, count);
  rateLimits.set(key, { count });
  cooldown(key, delayMs);
  return delayMs;
}
```

The scheduler persists `retryNotBefore`, rate-limit failure counts, and provider cooldowns. Retry/Resume must continue to respect these bounds. A capacity failure must not masquerade as a malformed bundle and fan out into individual card calls.

### New contract

- Expose a pure queue snapshot per lane: active/pending counts, effective concurrency, and cooldown remaining milliseconds. The shared-profile queue remains the sole live capacity owner; both lanes report the same wait when they share a profile.
- Progress and Providers show `Waiting for provider · retry in Ns` while cooldown blocks dispatch. Seconds are rounded up. An unavailable estimate stays unavailable; no invented deadline or success probability.
- Show remaining operation recovery allowance with the existing Resume/Retry controls. Resume preserves the operation budget. Retry Stage opens its documented new window but cannot dispatch through an unexpired profile cooldown.
- Reuse the UI's existing 500-ms update loop for the visible countdown; add no second polling timer. Rendering/status reads do not launch model calls.
- Stop cancels queued work immediately. Expiration of an old timer cannot revive it. Other profiles can continue, within their own queues.
- Persistent operation cooldowns cover reload/Resume; this project does not add account-wide durable provider state or silently preserve an old model's cooldown across a changed profile identity.

## 3. Preparation timing and understandable settings costs

Current timing correctly preserves null for missing primary-stream boundaries. Keep that behavior and distinguish queue wait, provider time, validation, checkpoint/persistence, preparation critical path, and primary reply time wherever actually observed. Never sum parallel provider durations and call the result elapsed preparation.

Add visible helper copy near the current controls:

- Cards per turn: `More cards can enlarge model requests and add individual repairs. Required cards may exceed this target.`
- Reasoner use: `Always routes eligible work through the Reasoner. Auto follows the selected reasoning level and provider checks.`
- Recovery: `Corrections and capacity retries add calls within the displayed recovery allowance.`

Keep saved choices, six-card default, independent target/routing, and existing disclosures intact. Explain that current normalization derives Reasoner use: Low is Off, while Medium/High/Ultra are Always; Auto is a policy value, not a separately selectable operator control. Add no guessed dollar prices, latency predictor, dashboard, or automatic setting changes.

The benchmark path gains a read-only analysis mode over sanitized diagnostic exports. It reports sample count, median/range preparation, primary reply, known queue time, call counts, correction causes, omissions, and required blocks, grouped by build and routing/target configuration. Partial/absent measurements remain explicit and are excluded from the corresponding calculation.

A paid live experiment requires explicit `--live`, an explicitly selected dedicated non-default user, explicit profile and sample count, and an existing safe live harness. Preserve the current benchmark's `--live` plus `validateSoakUserHandle()` guard; replace its default profile name with explicit selection and add an explicit sample bound. Compare target 6 versus 9 and the actual Low/Medium reasoning settings with the same fixture/model/profile, reporting their coupled routing/reasoning changes and output quality/required coverage alongside latency. An isolated Auto/Always comparison is unavailable in the current operator contract; do not invent that control or relabel Medium. The implementation acceptance criterion is correct measurement and preserved coverage, not an unmeasured percentage speedup.

## 4. Failure-focused operation history

### Current problem

The current append path is real code from `src/storage.mjs`:

```js
journal.entries.push(clean);
journal.entries = journal.entries.slice(-journal.maxEntries);
journal.nextIndex += 1;
```

The ring remains bounded and useful. Add a separately bounded `operationSummaries` collection in the same journal record, so 500 later prompt-clear entries cannot erase the latest completed/paused operation explanations.

### Data contract

- Keep at most **20** operations per chat, newest update last; update by operation ID rather than duplicating it. Eviction is deterministic. Clear Run Journal clears both ordinary entries and operation summaries. Existing chat cleanup removes the owned journal.
- Retain at most **32** stage summaries per operation and the latest **5** attempt outcomes per stage. Preserve total attempt and recovery counters even when detailed outcomes are truncated.
- Each attempt stores only attempt/window ordinal, outcome, fixed diagnostic/action code, safe failure code/class, at most eight canonical field issues, semantic validation rule, retry delay, and observed timing/usage numbers when available. No arbitrary provider message or correction text.
- Stage IDs are bounded to 180 characters; codes to 120; issue paths to 160; count values to 100,000. Field issues use the existing canonical issue normalizer. Collection limits are enforced when reading and writing.
- Unknown failure/action/diagnostic codes normalize to the fixed internal fallback or are omitted; arbitrary provider strings cannot become retained codes. Origin and latest-written build descriptors are separate observations, so a resumed operation is not falsely attributed entirely to its last build.
- Operation summaries contain operation ID, phase, state/outcome, timestamps, build descriptor, pipeline/lane, card target/selection/omission counts, required blocks, bounded stage summaries, and derived recovery totals. Unavailable values are null or omitted, never zero estimates.
- Outcomes distinguish `running`, `completed`, `completed-with-omissions`, `paused`, `canceled`, `interrupted`, `failed`, `stale`, and `abandoned` from actual state/reason. Successful corrections retain their history but do not turn a completed operation red.
- Before a successful attempt clears the active failure record, the scheduler persists its allowlisted attempt outcome. Optional rejected card semantics retained by Fused summaries use fixed rejection codes/families only.
- `savePipelineRun()` updates the operation summary using the persisted normalized manifest, then the journal's per-key mutation queue. A failed summary write produces a storage warning but does not retroactively cancel a verified generation or commit. No recursive journal-error loop.
- Timing journal events join an existing summary using their chat and `details.operationId`. Retain a bounded allowlist of observed timing values there; a late timing event cannot recreate an evicted operation or attach to a different one. Current state snapshots and historical measurements are distinct.
- Diagnostics export summaries alongside ordinary journal entries; the export remains private-prose-free. An incomplete history cannot be presented as a live run success rate.

Proposed shape, illustrated with safe values:

```js
{
  operationId: 'operation-synthetic', outcome: 'completed',
  recoveryCounts: { parseFailures: 1, correctionRequests: 1 },
  stages: [{ stageId: 'preprocess.guidance', state: 'completed', attemptCount: 2,
    attempts: [{ attempt: 1, outcome: 'rejected', code: 'RECURSION_JSON_PARSE_FAILED',
      action: 'retry-corrected' }, { attempt: 2, outcome: 'accepted' }] }]
}
```

## 5. Truthful cancellation and interrupted reloads

`providerFailure()` currently falls through to `category: provider-request` and `The selected model connection could not complete the request.` for an aborted request. Add a cancellation descriptor before other provider matching: `RECURSION_PROVIDER_ABORTED`, category `cancellation`, message `Provider request was canceled.`, retryable false. Preserve an explicitly known origin from trusted callers; unknown remains unknown. Do not infer a human click from a host stop.

The activity reporter has a separate explanation problem:

```js
const cause = detail.failure || detail.error || detail.compactError
  || detail.reason || detail.statusReason || detail.cautionReason;
const failure = failureFrom(cause, {
  code: 'RECURSION_ACTIVITY_REASON_MISSING', category: 'internal'
});
```

Bring it into the journal's current contract: safe explained warnings retain their explanation; explicit failures remain authoritative; unexplained warnings get the readable fallback. Trim before bounds, including reasons longer than 500 characters. Keep Progress warning copy readable without making a successful correction look like an active error.

Reload restoration already pauses running operations using `pauseReason: restored-after-reload`. Expose that as `Interrupted · Resume available` in the existing execution view and operation history. Verify no provider work starts from restoration, completed checkpoints remain reusable, unfinished execution tokens cannot commit late, stale source wins over resumability, and the recovery clock excludes the time the app was closed. No legacy manifest migration is introduced.

## 6. Correct card-history receipt basis

### Reproduced problem

This uses the actual host adapter with an in-memory chat and reproduces the current rejection:

```js
const context = { chatId: 'synthetic', chat: [
  { is_user: true, mes: 'Input' }, { is_user: false, mes: 'Initial reply' }
], saveChat: async () => {} };
const host = createSillyTavernHost({ contextFactory: () => context, settingsRoot: {} });
const before = await host.snapshot(); // prefix includes Initial reply
context.chat[1].mes += ' continued';
const expectedSourceIdentity = await host.messages.postProcessSourceIdentity();
const result = await host.messages.saveCardSelectionUsage({ expectedSourceIdentity,
  usage: { turnKeyHash: 'turn', deckId: 'deck', generationType: 'continue',
    sourcePrefixHash: before.cardSelectionSourcePrefixHash, cards: [] } });
// Current: { ok:false, reason:'card-selection-source-stale' }
```

Commit currently compares `cardSelectionHistoryForChat(chat.slice(0, found.index))`. The continued reply legitimately changed, so its preparation hash cannot equal that prefix. Do not change the story snapshot or accept either arbitrary hash as a fallback.

### New host-owned contract

`host.messages.cardSelectionReceiptBasis({ generationType })` captures a safe immutable basis before primary generation: generation type, chat identity, source prefix before the mutable output target, raw target index, optional exact target message/swipe IDs, and a deeply immutable prior valid same-target receipt when present. For normal appended responses the source prefix is the complete prior branch and target ID is null; the raw index still prevents redirecting completion to a later assistant. An existing empty Normal placeholder binds its raw index. For Continue the target must be the current assistant after the latest user; exclude that target only from receipt basis, while keeping it in the model's story snapshot. Swipe binds the native provisional active slot. Regenerate supports the existing target or the append position when the host has already removed that target.

Runtime captures this basis before constructing pending usage and passes its exact target binding through completion/incomplete-history calls. Complete and incomplete commits still validate current chat, active swipe/target, completion state, source prefix, and writable source identity immediately before mutation and persistence. Do not redirect a late receipt to a newly active message. Continue updates the same history position; when the captured prior receipt is valid and belongs to the same deck, preserve its card IDs and merge current selected IDs deterministically. Other decks do not inherit those IDs.

Split rejection reasons: `card-selection-receipt-invalid` for missing required IDs, `card-selection-prefix-changed` for edited prior source, and `card-selection-target-changed` for a changed bound output target. Existing source/host validation reasons remain authoritative. Safe journal details may record expected/observed hashes and numeric target IDs, but no message text, paths, or private rationale.

## Visual and operational constraints

Follow `DESIGN.md` and `docs/design/UI_SPEC.md`: compact SillyTavern-native graphite panels, existing Progress/Providers/Advanced rows, running cyan, verified success green, unresolved caution amber, material failure red, inactive/interrupted neutral with explicit text. No additional bar badge, toast, modal, marketing section, or persistent diagnostics dashboard. Helpers must be visible with tooltips off and usable at 390px width. Saved disclosures/drafts remain intact through status refreshes.

## Verification and delivery

Use real storage repositories, profile queues with fake clocks, scheduler/host integration fixtures, and production UI rendered against synthetic providers. Observe RED before each production fix. Cover same-profile lanes, separate profiles, abort while waiting, Retry/Resume cooldowns, history surviving ring rollover/reload, semantic correction success, corrupted/oversized build metadata, Default User benchmark refusal, Continue/swipe/edit/chat races, and input immutability.

Run appropriate focused suites, all offline tests, alpha gate, relevant browser proof, desktop/narrow settings screenshots, and syntax/diff checks. Request a fresh read-only whole-branch review and resolve material findings. Publish a verification report separating deterministic results, installed-copy checks, and paid/live evidence. Integrate against current main and push under existing authorization; keep the local Default User audit private and publish only aggregate evidence.
