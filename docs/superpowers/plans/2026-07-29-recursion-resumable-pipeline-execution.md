# Resumable Pipeline Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Recursion's multi-call pre-process and post-process pipelines durable, resumable, dependency-aware, and user-controllable without imposing a default wall-clock timeout or discarding completed work.

**Architecture:** Introduce a persisted per-chat operation manifest whose stages commit immutable, provenance-hashed checkpoints. A scheduler owns model-attempt policy, stage execution, pausing, resuming, retrying, and dependency-aware reprocessing; provider routing becomes a single-attempt transport rather than a hidden retry loop. Existing Segmented, Fused, and post-process behavior becomes stage adapters over that scheduler, while progress UI projects the durable manifest into one contextual action per executable row.

**Tech Stack:** JavaScript ES modules, Node.js test scripts, SillyTavern extension APIs, DOM/CSS, Recursion's storage repository, Web Crypto/Node crypto-compatible hashing, Git.

## Global Constraints

- Treat the approved design at `docs/superpowers/specs/2026-07-29-recursion-resumable-pipeline-execution-design.md` as the source of truth.
- Before any visible UI edit, reread `DESIGN.md` and `docs/design/UI_SPEC.md` as required by `AGENTS.md`.
- Keep the Arbiter model-owned. Do not add deterministic semantic selection or a deterministic Arbiter fallback.
- Do not impose a default Recursion wall-clock timeout on generation/model stages. An explicit bounded timeout remains valid only for user-invoked provider diagnostics.
- Set `modelAttemptsPerStep` to `2` by default, clamp it to `1..5`, and count the initial request as attempt one.
- Give every model stage its own attempt window. Do not introduce an operation-wide attempt cap.
- Make the scheduler the sole owner of automatic attempts. Structured correction requests consume the same stage attempt window.
- Do not automatically retry SillyTavern's primary story generation.
- Stop means pause: abort every in-flight Recursion request, discard partial responses, and preserve only atomically committed checkpoints.
- Never auto-resume after reload, chat change, provider change, source change, or staleness detection.
- Persist resume artifacts separately from activity, diagnostics, journals, and chat markers. Never expose artifact bodies in those surfaces.
- Maintain at most one nonterminal pipeline operation per chat.
- Use one contextual 24px action per independently executable progress row.
- Use `Queued` as the canonical user-facing term. Do not introduce `armed` as a new lifecycle term.
- Rename Standard to Segmented with canonical `pipelineMode: "segmented"`. Retire Rapid completely. Normalize any unknown stored mode, including old `standard` and `rapid` strings, through the generic invalid-value fallback to `segmented`; do not preserve compatibility aliases.
- Preserve the existing `Reset Scene Cache` action and extend it to clear the current chat's operation manifest, resume artifacts, queued reprocess intent, and prompt install residue.
- Follow Red-Green-Refactor for every behavior change. Run the narrow test after each red and green step.
- Use controllable promises and fake clocks. Do not make tests wait for real provider latency or real 120-second deadlines.
- Before committing a task that modifies shared provider, runtime, storage, progress, UI, host, or extension entrypoint code, run `npm.cmd test` after its listed narrow tests and repair any cross-suite regression in that same task.
- Keep every task independently reviewable and commit it before beginning the next task.

---

### Task 1: Define Durable Execution Contracts and Provenance

**Files:**

- Create: `src/execution/checkpoints.mjs`
- Create: `src/execution/provenance.mjs`
- Create: `tools/scripts/test-execution-contracts.mjs`

**Interfaces:**

```js
export const PIPELINE_RUN_SCHEMA = 'recursion.pipelineRun.v1';
export const CHECKPOINT_SCHEMA = 'recursion.stageCheckpoint.v1';

export const OPERATION_STATES = Object.freeze([
    'running',
    'paused',
    'completed',
    'stale',
    'abandoned',
]);

export const STAGE_STATES = Object.freeze([
    'pending',
    'running',
    'failed',
    'completed',
    'skipped',
    'stale',
]);

export function createPipelineRun(input);
export function normalizePipelineRun(value);
export function createStageRecord(input);
export function normalizeStageRecord(value);
export function createCheckpoint(input);
export function normalizeCheckpoint(value);
export function isTerminalOperationState(state);
export function isCheckpointReusable({
    checkpoint,
    stage,
    dependencyCheckpoints,
    artifactHash,
    expectedProvenance,
});
export async function stableHash(value);
export function buildRunProvenance(input);
export function compareRunProvenance(expected, actual);
```

- A run record contains identifiers and metadata only: `operationId`, `graphVersion`, `phase`, `pipelineMode`, `chatKey`, `sourceIdentity`, `state`, `pauseReason`, `frontierStageIds`, `queuedStageIds`, `stageRecords`, `createdAt`, and `updatedAt`.
- A checkpoint contains `operationId`, `stageId`, `stageVersion`, `state`, `inputHash`, `outputHash`, `dependencyHashes`, stage-scoped `provenance`, `attempts`, `artifactRef`, and `completedAt`.
- Artifact bodies live behind `artifactRef`; they are not embedded in the manifest.
- Provenance covers chat/source identity, source text hash, relevant settings hash, provider/model selection, pipeline mode, card configuration, prompt/version identifiers, and post-process mode.
- Stable hashing recursively sorts object keys, preserves array order, and rejects unsupported values rather than relying on engine-specific JSON order.

- [ ] **Step 1: Write contract tests first**

Create `tools/scripts/test-execution-contracts.mjs` with focused assertions:

```js
import {
    CHECKPOINT_SCHEMA,
    PIPELINE_RUN_SCHEMA,
    createCheckpoint,
    createPipelineRun,
    isCheckpointReusable,
    normalizePipelineRun,
} from '../../src/execution/checkpoints.mjs';
import {
    buildRunProvenance,
    compareRunProvenance,
    stableHash,
} from '../../src/execution/provenance.mjs';
import {
    assert,
    assertDeepEqual,
    assertEqual,
} from '../../tests/helpers/assert.mjs';

const sourceIdentity = {
    sourceRevisionHash: 'source-hash',
    latestMessageId: 'message-7',
    selectedSwipeId: 'swipe-1',
    characterHash: 'character-hash',
    groupHash: '',
};
const provenance = buildRunProvenance({
    chatKey: 'chat-a',
    sourceIdentity,
    settingsHash: 'settings-hash',
    provider: { id: 'openai', model: 'model-a' },
    pipelineMode: 'segmented',
    promptVersions: { arbiter: 3, card: 5 },
});

const run = createPipelineRun({
    operationId: 'run-a',
    chatKey: 'chat-a',
    phase: 'preprocess',
    pipelineMode: 'segmented',
    createdAt: '2026-07-29T12:00:00.000Z',
    sourceIdentity,
});

assertEqual(run.schema, PIPELINE_RUN_SCHEMA);
assertEqual(run.state, 'paused');
assertDeepEqual(run.stageRecords, {});
assertEqual(normalizePipelineRun({ ...run, artifactBody: 'secret' }).artifactBody, undefined);

const checkpoint = createCheckpoint({
    operationId: 'run-a',
    stageId: 'preprocess.arbiter',
    stageVersion: 3,
    inputHash: 'input-a',
    dependencyHashes: {},
    outputHash: 'artifact-hash-a',
    provenance,
    attempts: { window: 1, limit: 2, used: 1, total: 1 },
    artifactRef: { kind: 'logical-storage', key: 'artifact-a', hash: 'artifact-hash-a' },
    completedAt: '2026-07-29T12:00:01.000Z',
});

assertEqual(checkpoint.schema, CHECKPOINT_SCHEMA);
assert(isCheckpointReusable({
    checkpoint,
    stage: { id: 'preprocess.arbiter', version: 3, inputHash: 'input-a', provenance },
    dependencyCheckpoints: {},
    artifactHash: 'artifact-hash-a',
    expectedProvenance: provenance,
}));

assertEqual(await stableHash({ b: 2, a: 1 }), await stableHash({ a: 1, b: 2 }));
assertDeepEqual(compareRunProvenance(provenance, provenance), {
    reusable: true,
    changedFields: [],
});
assertEqual(compareRunProvenance(
    provenance,
    { ...provenance, sourceTextHash: 'changed' },
).reusable, false);
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```powershell
node tools/scripts/test-execution-contracts.mjs
```

Expected: failure with `ERR_MODULE_NOT_FOUND` for `src/execution/checkpoints.mjs`.

- [ ] **Step 3: Implement stable hashing and provenance comparison**

In `src/execution/provenance.mjs`, add a canonical serializer and SHA-256 hash:

```js
function canonicalize(value) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && Object.getPrototypeOf(value) === Object.prototype) {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, canonicalize(value[key])]),
        );
    }
    throw new TypeError('Execution provenance must contain JSON-safe values.');
}

export async function stableHash(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
```

`buildRunProvenance` must return a normalized, JSON-safe object. `compareRunProvenance` must return every top-level changed field so stale-state diagnostics can explain the boundary without recording prompt or artifact bodies.

- [ ] **Step 4: Implement strict manifest, stage, and checkpoint normalizers**

In `src/execution/checkpoints.mjs`:

```js
export function createPipelineRun({
    operationId,
    chatKey,
    phase,
    pipelineMode,
    createdAt,
    sourceIdentity,
}) {
    return {
        schema: PIPELINE_RUN_SCHEMA,
        operationId: String(operationId),
        graphVersion: 1,
        phase,
        chatKey: String(chatKey),
        pipelineMode,
        state: 'paused',
        pauseReason: 'created',
        sourceIdentity,
        frontierStageIds: [],
        queuedStageIds: [],
        stageRecords: {},
        createdAt,
        updatedAt: createdAt,
    };
}
```

Add allowlist-based normalization; never spread unknown persisted fields into normalized records. `isCheckpointReusable` must require exact stage version, input hash, dependency hash, output hash/artifact-ref integrity, and reusable stage-scoped provenance. Cached and recovered are progress projections, not persisted execution states; a paused operation leaves interrupted frontier stages `pending`.

- [ ] **Step 5: Run the contract test and verify it passes**

Run:

```powershell
node tools/scripts/test-execution-contracts.mjs
```

Expected: `Execution contracts tests passed.`

- [ ] **Step 6: Commit the execution contracts**

```powershell
git add src/execution/checkpoints.mjs src/execution/provenance.mjs tools/scripts/test-execution-contracts.mjs
git commit -m "feat: define pipeline execution contracts"
```

---

### Task 2: Persist Manifests, Artifact Bodies, and Queued Intent Separately

**Files:**

- Modify: `src/storage.mjs`
- Modify: `tools/scripts/test-storage.mjs`
- Create: `tools/scripts/test-execution-storage.mjs`

**Interfaces:**

```js
export function pipelineRunKey(chatKey);
export function pipelineArtifactKey(chatKey, runId, artifactId);
export function queuedReprocessKey(chatKey);

repository.loadPipelineRun(chatKey);
repository.savePipelineRun(chatKey, manifest);
repository.clearPipelineRun(chatKey);
repository.loadPipelineArtifact(chatKey, runId, artifactId);
repository.savePipelineArtifact(chatKey, runId, artifactId, artifact);
repository.clearPipelineArtifacts(chatKey, runId);
repository.loadQueuedReprocess(chatKey);
repository.saveQueuedReprocess(chatKey, intent);
repository.clearQueuedReprocess(chatKey);
repository.clearPipelineExecution(chatKey);
```

- `savePipelineArtifact` writes the body first and returns its `artifactRef`; a manifest may point only to a successfully saved artifact.
- `clearPipelineExecution` clears the manifest, all indexed artifact bodies, and queued intent for one exact chat key.
- New index kinds participate in `repairIndex`, retention, and current-chat reset.
- Journals and diagnostic exports may include run/stage ids, timings, attempt counts, state, failure class, and artifact hashes, but never artifact bodies.

- [ ] **Step 1: Add failing storage-isolation tests**

Create `tools/scripts/test-execution-storage.mjs`:

```js
import {
    createMemoryStorageAdapter,
    createStorageRepository,
    pipelineRunKey,
    queuedReprocessKey,
} from '../../src/storage.mjs';
import { createPipelineRun } from '../../src/execution/checkpoints.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

const adapter = createMemoryStorageAdapter();
const repository = createStorageRepository({ storage: adapter });

await repository.savePipelineArtifact('chat-a', 'run-a', 'arbiter', {
    arbiterOutput: {
        selectedCards: ['character'],
        rationale: 'CANARY_ARBITER_ARTIFACT_BODY',
    },
});
await repository.savePipelineRun('chat-a', createPipelineRun({
    operationId: 'run-a',
    chatKey: 'chat-a',
    phase: 'preprocess',
    pipelineMode: 'segmented',
    sourceIdentity: {
        sourceRevisionHash: 'source-a',
        latestMessageId: 'message-a',
        selectedSwipeId: 'swipe-a',
        characterHash: 'character-a',
        groupHash: '',
    },
    createdAt: '2026-07-29T12:00:00.000Z',
}));
await repository.saveQueuedReprocess('chat-a', {
    schema: 'recursion.queued-reprocess.v1',
    stageIds: ['card.character'],
    mode: 'stage',
});

assert((await repository.loadPipelineArtifact('chat-a', 'run-a', 'arbiter')).arbiterOutput);
assertEqual((await repository.loadPipelineRun('chat-a')).state, 'paused');
assertDeepEqual((await repository.loadQueuedReprocess('chat-a')).stageIds, ['card.character']);

const runRaw = await adapter.readJson(pipelineRunKey('chat-a'));
const queuedRaw = await adapter.readJson(queuedReprocessKey('chat-a'));
assert(!JSON.stringify(runRaw).includes('CANARY_ARBITER_ARTIFACT_BODY'));
assert(!JSON.stringify(queuedRaw).includes('CANARY_ARBITER_ARTIFACT_BODY'));

await repository.clearPipelineExecution('chat-a');
assertEqual(await repository.loadPipelineRun('chat-a'), null);
assertEqual(await repository.loadPipelineArtifact('chat-a', 'run-a', 'arbiter'), null);
assertEqual(await repository.loadQueuedReprocess('chat-a'), null);
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```powershell
node tools/scripts/test-execution-storage.mjs
```

Expected: import failure because `pipelineRunKey` is not exported.

- [ ] **Step 3: Add logical keys and repository methods**

Add exact, chat-scoped logical keys:

```js
export function pipelineRunKey(chatKey) {
    return `recursion-pipeline-run-${safeId(chatKey, 'chat')}.v1.json`;
}

export function pipelineArtifactKey(chatKey, runId, artifactId) {
    return [
        'recursion-pipeline-artifact',
        safeId(chatKey, 'chat'),
        safeId(runId, 'operation'),
        safeId(artifactId, 'artifact'),
        'v1.json',
    ].join('-');
}

export function queuedReprocessKey(chatKey) {
    return `recursion-queued-reprocess-${safeId(chatKey, 'chat')}.v1.json`;
}
```

Implement repository methods with existing atomic adapter primitives. Index records must store only key, chat key, run id, artifact id, kind, size, and timestamps.

- [ ] **Step 4: Extend index repair, prune, and reset tests**

In `tools/scripts/test-storage.mjs`, add:

```js
assert(repaired.repaired.some((entry) => entry.kind === 'pipelineRun'));
assert(repaired.repaired.some((entry) => entry.kind === 'pipelineArtifact'));
assert(repaired.repaired.some((entry) => entry.kind === 'queuedReprocess'));
```

Also prove pruning an abandoned run removes its artifacts and that pruning never removes a nonterminal current-chat run.

- [ ] **Step 5: Run storage tests and verify they pass**

Run:

```powershell
node tools/scripts/test-execution-storage.mjs
node tools/scripts/test-storage.mjs
```

Expected: both scripts pass.

- [ ] **Step 6: Commit durable execution storage**

```powershell
git add src/storage.mjs tools/scripts/test-storage.mjs tools/scripts/test-execution-storage.mjs
git commit -m "feat: persist resumable pipeline state"
```

---

### Task 3: Make Provider Routing Single-Attempt and Remove Default Generation Timeouts

**Files:**

- Modify: `src/providers.mjs`
- Modify: `src/settings.mjs`
- Modify: `src/runtime.mjs`
- Create: `src/execution/attempt-policy.mjs`
- Modify: `tools/scripts/test-providers.mjs`
- Modify: `tools/scripts/test-settings.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `tools/scripts/test-editorial-runtime.mjs`
- Create: `tools/scripts/test-execution-attempt-policy.mjs`

**Interfaces:**

```js
router.generate(roleId, request, {
    signal,
    runId,
    timeoutMs = null,
});

router.batch(requests, {
    signal,
    runId,
    timeoutMs = null,
});

export function classifyModelFailure(error);
export async function runModelStageAttempts({
    attemptsPerStep,
    request,
    invoke,
    validate,
    buildCorrectionRequest,
    signal,
    onAttemptSettled,
});
```

- `generate` performs exactly one provider request and no structured correction.
- `batch` performs exactly one batch wave; each member is exactly one request.
- A null timeout means no Recursion-owned timer is created.
- The provider test action passes its existing explicit diagnostic timeout.
- Existing Generation Review, Editorial, and Enhancement calls lose their hard-coded 120-second request/barrier deadlines; they remain pending until provider/host settlement, Stop, or source supersession.
- `runModelStageAttempts` owns attempts, correction requests, abort behavior, and attempt summaries.
- Abort is terminal for the current invocation and never consumes a new automatic attempt.
- Validation failure may produce a correction request, but that request consumes the next attempt.
- A manual Retry calls `runModelStageAttempts` again with a fresh full window.

- [ ] **Step 1: Change provider tests to require one request and no default timer**

In `tools/scripts/test-providers.mjs`, replace hidden-retry expectations with:

```js
const pending = router.generate('arbiter', { prompt: 'choose' }, { runId: 'run-a' });
assertEqual(providerCalls.length, 1);
assertEqual(providerCalls[0].timeoutMs, null);
providerCalls[0].resolve({ text: '{"cards":["character"]}' });
await pending;
assertEqual(providerCalls.length, 1);
```

In `tools/scripts/test-runtime.mjs`, replace the old As Swipe timeout assertion and add a fake-clock regression:

```js
assertEqual(routerCalls[0].options.timeoutMs ?? null, null);
fakeClock.advanceBy(121_000);
await flushPromises();
assertEqual(reviewPromise.state, 'pending');
provider.resolve(validReview);
await reviewPromise;
```

Keep `runtime.testProvider()` explicitly bounded at `30_000`.

Add an explicit diagnostic assertion:

```js
await router.generate('provider-test', request, { timeoutMs: 30_000 });
assertEqual(providerCalls.at(-1).timeoutMs, 30_000);
```

- [ ] **Step 2: Add failing attempt-window tests with controllable promises**

Create `tools/scripts/test-execution-attempt-policy.mjs` and import `runModelStageAttempts` from `src/execution/attempt-policy.mjs`:

```js
const calls = [];
const settled = [];
const result = await runModelStageAttempts({
    attemptsPerStep: 2,
    request: { prompt: 'initial' },
    invoke: async (request) => {
        calls.push(request);
        return calls.length === 1
            ? { text: 'not-json' }
            : { text: '{"ok":true}' };
    },
    validate: ({ text }) => {
        const value = JSON.parse(text);
        return { ok: true, value };
    },
    buildCorrectionRequest: ({ request }) => ({
        ...request,
        prompt: 'Return valid JSON.',
    }),
    onAttemptSettled: (attempt) => settled.push(attempt),
});

assertEqual(result.ok, true);
assertEqual(calls.length, 2);
assertEqual(settled.length, 2);
assertEqual(settled[0].outcome, 'invalid');
assertEqual(settled[1].outcome, 'accepted');
```

Also cover:

- two transport failures stop after two total requests;
- an abort during attempt one creates no attempt two;
- `attemptsPerStep: 1` performs no correction call;
- a separate manual invocation receives a fresh two-attempt window;
- failures expose classification and safe summaries, not raw prompt/result bodies.

- [ ] **Step 3: Run the provider, settings, and attempt tests and verify red**

Run:

```powershell
node tools/scripts/test-providers.mjs
node tools/scripts/test-settings.mjs
node tools/scripts/test-runtime.mjs
node tools/scripts/test-editorial-runtime.mjs
node tools/scripts/test-execution-attempt-policy.mjs
```

Expected: provider assertions still see the 120000ms default/hidden retry behavior, settings lack `modelAttemptsPerStep`, and the attempt module cannot be imported.

- [ ] **Step 4: Add and normalize the attempts setting**

In `src/settings.mjs`:

```js
export const DEFAULT_SETTINGS = Object.freeze({
    // existing settings
    modelAttemptsPerStep: 2,
});

function normalizeModelAttemptsPerStep(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return 2;
    return Math.min(5, Math.max(1, parsed));
}
```

Apply normalization during load and patches. Add test cases for missing, `0`, `1`, `4`, `6`, numeric strings, and invalid text.

- [ ] **Step 5: Refactor the provider router to single-attempt transport**

Remove `DEFAULT_PROVIDER_TIMEOUT_MS` from the generation path. Remove `GENERATION_REVIEW_TIMEOUT_MS`, `GENERATION_REVIEW_BARRIER_TIMEOUT_MS`, the undefined/legacy `PROSE_ENHANCEMENT_TIMEOUT_MS` options, and all other Recursion-owned model-call deadlines from `src/runtime.mjs`. Replace the timeout-based review barrier with settlement/abort coordination. Extract one transport invocation:

```js
async function generate(roleId, request, {
    signal,
    runId,
    timeoutMs = null,
} = {}) {
    return invokeProvider({
        roleId,
        request,
        signal,
        runId,
        timeoutMs,
    });
}
```

Delete the internal attempt loop and structured-recovery loop. Implement `batch` as one parallel wave of single-attempt `generate` calls sharing the caller's abort signal. Remove obsolete `isRetryCurrent`, `isCurrent`, `maxAttempts`, and `allowStructuredRecovery` plumbing from wrappers and callers; Tasks 6 and 7 place the durable Pre-process and Post-process calls under the scheduler.

- [ ] **Step 6: Implement scheduler-owned attempt policy**

In `src/execution/attempt-policy.mjs`, explicitly loop from `1` through `attemptsPerStep`, classify transport/validation failures, and call `onAttemptSettled` after each settled attempt. Do not persist raw response text in attempt summaries.

- [ ] **Step 7: Run narrow tests and scan active defaults**

Run:

```powershell
node tools/scripts/test-providers.mjs
node tools/scripts/test-settings.mjs
node tools/scripts/test-runtime.mjs
node tools/scripts/test-editorial-runtime.mjs
node tools/scripts/test-execution-attempt-policy.mjs
rg -n "120000|120_000|DEFAULT_PROVIDER_TIMEOUT|GENERATION_REVIEW_TIMEOUT|PROSE_ENHANCEMENT_TIMEOUT|maxAttempts|allowStructuredRecovery" src
```

Expected:

- all three tests pass;
- no active provider/model generation path owns a default 120-second timer;
- only explicit diagnostic timeout code remains;
- no active hidden provider retry options remain.

- [ ] **Step 8: Commit single-attempt provider routing**

```powershell
git add src/providers.mjs src/settings.mjs src/runtime.mjs src/execution/attempt-policy.mjs tools/scripts/test-providers.mjs tools/scripts/test-settings.mjs tools/scripts/test-runtime.mjs tools/scripts/test-editorial-runtime.mjs tools/scripts/test-execution-attempt-policy.mjs
git commit -m "refactor: centralize model attempt policy"
```

---

### Task 4: Build the Checkpointing Execution Scheduler

**Files:**

- Create: `src/execution/stage-registry.mjs`
- Create: `src/execution/scheduler.mjs`
- Create: `src/execution/queued-reprocess.mjs`
- Create: `tools/scripts/test-execution-scheduler.mjs`
- Create: `tools/scripts/test-queued-reprocess.mjs`

**Interfaces:**

```js
export function createExecutionScheduler({
    repository,
    now,
    createId,
    attemptsPerStep,
    onViewChanged,
});

scheduler.start({ manifest, graph, context });
scheduler.pause({ operationId, reason });
scheduler.resume({ operationId, graph, context, provenance });
scheduler.retry({ operationId, stageId, graph, context, provenance });
scheduler.abandon({ operationId, reason });
scheduler.getActiveOperation();

export function createExecutionGraph({ stages });
export function planReprocess({ graph, manifest, selectedStageIds, fullFresh });
export function normalizeQueuedReprocess(value);
export function mergeQueuedReprocess(current, next, graph);
export function bindQueuedReprocess({ intent, graph, manifest, provenance });
export function consumeQueuedStageStart({ intent, stageId });
```

Stage adapter contract:

```js
{
    id: 'preprocess.cards.segmented.character',
    version: 1,
    kind: 'model',
    executable: true,
    dependencies: ['preprocess.arbiter'],
    checkpoint: 'durable',
    failurePolicy: 'continue',
    buildInputFingerprint(context, dependencies),
    buildRequest(context, dependencies),
    async run({ request, signal }),
    validate(artifact),
    summarizeArtifact(artifact),
}
```

- The scheduler writes stage `running` state before invocation.
- A response becomes reusable only after the artifact body is saved, validated, hashed, and its checkpoint is atomically linked from the manifest.
- Pause aborts all active controllers for the operation, waits for them to settle, converts uncommitted `running` stages to `pending`, and persists the manifest.
- A late response from an aborted or superseded execution token cannot commit.
- Resume validates run provenance and every reusable checkpoint before scheduling.
- A provenance mismatch sets the operation to `stale`, records only changed field names, and offers no Resume.
- A blocking exhausted stage stays `failed` while the operation becomes `paused`; operation state never invents a separate `failed` value.
- Concurrent children may run together, but Stop is operation-scoped.
- Retry is valid only for the blocking failed stage and gives that stage a fresh attempt window.
- Reprocess invalidates the selected stage and dependency-changed descendants; unrelated siblings remain reusable.
- A queued ancestor subsumes queued descendants.
- Full fresh invalidates every executable stage for one next operation while retaining old artifacts until replacement checkpoints commit.
- The next send/swipe binds the intent into `manifest.queuedStageIds`, but persistence is cleared only when the selected root stage begins. Stop/cancel before that boundary leaves the chat-scoped intent queued.
- Once a selected root begins, its intent is consumed even if that execution later fails; the replaced checkpoint is not admitted as a fallback for that operation.
- An inapplicable persisted stage id is cleared with the bounded `stage-reprocess-inapplicable` notice; it is never guessed or remapped.

- [ ] **Step 1: Write scheduler lifecycle tests with controllable promises**

In `tools/scripts/test-execution-scheduler.mjs`, create a deferred helper and prove:

```js
const arbiter = deferred();
const cardA = deferred();
const cardB = deferred();
const graph = createExecutionGraph({
    stages: [
        stage('arbiter', [], () => arbiter.promise),
        stage('card.a', ['arbiter'], () => cardA.promise),
        stage('card.b', ['arbiter'], () => cardB.promise),
    ],
});

const startPromise = scheduler.start({ manifest, graph, context: {} });
assertDeepEqual(repository.savedManifest.frontierStageIds, ['arbiter']);
arbiter.resolve({ selected: ['a', 'b'] });
await flushPromises();
assertEqual(repository.savedManifest.stageRecords.arbiter.state, 'completed');

await scheduler.pause({ operationId: manifest.operationId, reason: 'user' });
assertEqual(repository.savedManifest.state, 'paused');
assertEqual(repository.savedManifest.stageRecords['card.a'].state, 'pending');
assertEqual(repository.savedManifest.stageRecords['card.b'].state, 'pending');

cardA.resolve({ value: 'late-a' });
cardB.resolve({ value: 'late-b' });
await startPromise;
assertEqual(repository.savedManifest.stageRecords['card.a'].checkpoint, null);
assertEqual(repository.savedManifest.stageRecords['card.b'].checkpoint, null);
```

Add independent tests for:

- artifact write failure never creates a checkpoint;
- manifest write failure leaves the old checkpoint authoritative;
- completed checkpoints are reused on Resume;
- dependency hash change invalidates only descendants;
- concurrent child failure does not discard a successful sibling;
- duplicate Resume calls do not start duplicate stage executions;
- a stale run has `state: "stale"` and Resume rejects;
- starting an incompatible operation for the same chat atomically marks the older nonterminal operation `abandoned` before the new one becomes active, so two never coexist;
- a different chat may have its own nonterminal operation;
- manual Retry resets the failed stage's attempt counter;
- Stop during attempt one records interruption without starting attempt two; explicit Resume opens `window: 2`, resets `used` for the new window, and keeps monotonic `total`;
- aborting one running child aborts every running child in the same operation.

- [ ] **Step 2: Write queued-reprocess tests**

In `tools/scripts/test-queued-reprocess.mjs`, assert:

```js
const merged = mergeQueuedReprocess(
    { stageIds: ['preprocess.cards.segmented.character'] },
    { stageIds: ['preprocess.arbiter'] },
    graph,
);
assertDeepEqual(merged.stageIds, ['preprocess.arbiter']);

const plan = planReprocess({
    graph,
    manifest,
    selectedStageIds: ['preprocess.cards.segmented.character'],
    fullFresh: false,
});
assertDeepEqual(plan.forcedStageIds, ['preprocess.cards.segmented.character']);
assert(plan.reusableStageIds.includes('preprocess.cards.segmented.setting'));

const fullFreshPlan = planReprocess({
    graph,
    manifest,
    selectedStageIds: [],
    fullFresh: true,
});
assertEqual(fullFreshPlan.bypassAllCheckpoints, true);
```

Also prove:

- rerunning a selected ancestor to the same `outputHash` leaves an unchanged descendant reusable;
- a changed ancestor `outputHash` reruns only its descendants;
- independent siblings remain reusable in both cases;
- binding alone does not clear an intent;
- cancellation/Stop before the selected root starts leaves it queued;
- stage start consumes it once;
- a failed selected stage cannot fall back to its old checkpoint;
- a canceled intent does nothing;
- selected stages always rerun even if their input hash is unchanged;
- old artifact references remain stored until replacements commit.

- [ ] **Step 3: Run scheduler tests and verify red**

Run:

```powershell
node tools/scripts/test-execution-scheduler.mjs
node tools/scripts/test-queued-reprocess.mjs
```

Expected: module-not-found failures for the new scheduler and reprocess modules.

- [ ] **Step 4: Implement graph validation and reprocess planning**

Implement `createExecutionGraph` in `src/execution/stage-registry.mjs`; it must reject duplicate ids, missing dependencies, and cycles and build reverse dependency indexes once. Implement queued-intent normalization and `planReprocess` in `src/execution/queued-reprocess.mjs`:

```js
return {
    selectedStageIds,
    forcedStageIds,
    reusableStageIds,
    invalidatedStageIds,
    bypassAllCheckpoints: Boolean(fullFresh),
};
```

For descendants, compare their recomputed dependency hashes at execution time; do not eagerly discard a descendant checkpoint solely because an ancestor was selected.

- [ ] **Step 5: Implement scheduler persistence and execution tokens**

Every stage invocation receives a unique execution token. Before committing, reload or compare the manifest revision and require:

```js
currentOperation.id === operationId
    && currentStage.executionToken === executionToken
    && !signal.aborted
    && currentOperation.state === 'running'
```

Save the artifact, validate/hash it, then atomically update the manifest checkpoint. If the manifest update fails, the unreferenced artifact may be removed during repair.

- [ ] **Step 6: Implement pause, resume, retry, stale, and abandon paths**

Pause must abort all operation controllers and settle them without waiting for provider timeout. Resume and Retry require explicit calls. Abandon preserves final safe summaries but deletes intermediate resume-only artifacts according to the retention rules added in Task 10.

- [ ] **Step 7: Run scheduler and storage tests**

Run:

```powershell
node tools/scripts/test-execution-scheduler.mjs
node tools/scripts/test-queued-reprocess.mjs
node tools/scripts/test-execution-storage.mjs
```

Expected: all pass with no unhandled rejection output.

- [ ] **Step 8: Commit the scheduler**

```powershell
git add src/execution/stage-registry.mjs src/execution/scheduler.mjs src/execution/queued-reprocess.mjs tools/scripts/test-execution-scheduler.mjs tools/scripts/test-queued-reprocess.mjs
git commit -m "feat: add checkpointing pipeline scheduler"
```

---

### Task 5: Rename Standard to Segmented and Adapt Both Card Pipelines

**Files:**

- Rename: `src/runtime/pipelines/standard.mjs` → `src/runtime/pipelines/segmented.mjs`
- Modify: `src/runtime/pipelines/fused.mjs`
- Delete: `src/runtime/pipelines/rapid.mjs`
- Delete: `src/rapid-pipeline.mjs`
- Delete: `src/rapid-warm-state.mjs`
- Create: `src/runtime/preprocess-graph.mjs`
- Modify: `src/runtime.mjs`
- Modify: `src/runtime/run-state.mjs`
- Modify: `src/runtime/diagnostics.mjs`
- Modify: `src/extension/index.js`
- Modify: `src/progress.mjs`
- Modify: `src/storage.mjs`
- Modify: `src/ui.mjs`
- Modify: `src/settings.mjs`
- Modify: `src/ui/view-model.mjs`
- Delete: `tools/scripts/test-rapid-pipeline.mjs`
- Delete: `tools/scripts/test-rapid-warm-state.mjs`
- Create: `tools/scripts/test-pipeline-segmented.mjs`
- Create: `tools/scripts/test-pipeline-fused.mjs`
- Create: `tools/scripts/test-preprocess-graph.mjs`
- Modify: `tools/scripts/test-settings.mjs`
- Create: `tools/scripts/test-ui-view-model.mjs`
- Modify: `tools/scripts/test-extension-smoke.mjs`
- Modify: `tools/scripts/test-live-enhancement-run-oracle.mjs`
- Modify: `tools/scripts/test-live-harness.mjs`
- Modify: `tools/scripts/test-live-pipeline-proof.mjs`
- Modify: `tools/scripts/test-progress.mjs`
- Modify: `tools/scripts/test-prompt.mjs`
- Modify: `tools/scripts/test-providers.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `tools/scripts/test-storage.mjs`
- Modify: `tools/scripts/test-ui.mjs`
- Modify: `tools/scripts/lib/live-editorial-effectiveness.mjs`
- Modify: `tools/scripts/prove-editorial-transformation-ui.mjs`
- Modify: `tools/scripts/prove-live-enhancements.mjs`
- Modify: `tools/scripts/prove-live-pipelines.mjs`
- Modify: `tools/scripts/prove-live-prompt-packet.mjs`
- Modify: `tools/scripts/prove-live-swipe-reuse.mjs`
- Modify: `tools/scripts/audit-refactor-hotspots.mjs`

**Interfaces:**

```js
export function createSegmentedCardStages({
    selectedCards,
    createCardRequest,
    validateCard,
    generateCard,
});

export function createFusedCardStages({
    selectedCards,
    createBundleRequest,
    validateBundle,
    generateBundle,
    createSegmentedFallbackStages,
});
```

- The final pipeline enum becomes `segmented|fused` in this task, and Rapid is physically removed with every active call site so the repository remains green after the migration commit.
- Settings default and generic invalid fallback become `segmented`.
- Do not map old strings through aliases:

```js
const PIPELINE_MODES = new Set(['segmented', 'fused']);
const pipelineMode = PIPELINE_MODES.has(value) ? value : 'segmented';
```

- Segmented exposes one executable child per selected card. Children share the Arbiter dependency and may run concurrently.
- Fused exposes one executable bundle parent. Its card children are validation outcomes and never own actions.
- Valid Fused siblings survive a partial bundle result.
- If the Fused attempt window ends with zero useful cards, schedule one Segmented fallback wave without rerunning the Arbiter.
- The Fused bundle has one attempt window; every fallback Segmented card has its own window.

- [ ] **Step 1: Rename tests and make vocabulary assertions fail**

Update test names/imports and add:

```js
assertEqual(normalizeSettings({ pipelineMode: 'segmented' }).pipelineMode, 'segmented');
assertEqual(normalizeSettings({ pipelineMode: 'standard' }).pipelineMode, 'segmented');
assertEqual(normalizeSettings({ pipelineMode: 'rapid' }).pipelineMode, 'segmented');
assertEqual(normalizeSettings({ pipelineMode: 'anything-else' }).pipelineMode, 'segmented');
assertEqual(createRecursionViewModel({
    settings: { pipelineMode: 'segmented' },
}).pipelineLabel, 'Segmented');
```

The equality for old values proves generic fallback behavior only; production code must not contain a `standard -> segmented` or `rapid -> segmented` alias table.
Add a settings-store round trip proving an invalid persisted value loads as `segmented` and the next save writes only the canonical value.

- [ ] **Step 2: Add failing Segmented stage-shape tests**

```js
const stages = createSegmentedCardStages({
    selectedCards: ['character', 'setting'],
    createCardRequest,
    validateCard,
    generateCard,
});

assertDeepEqual(stages.map(({ id }) => id), [
    'preprocess.cards.segmented.character',
    'preprocess.cards.segmented.setting',
]);
assert(stages.every((stage) => stage.executable));
assert(stages.every((stage) => stage.dependencies.includes('preprocess.arbiter')));
```

Add a scheduler integration case where `card.character` succeeds, `card.setting` fails, and the successful character checkpoint remains reusable on Retry.

- [ ] **Step 3: Add failing Fused fallback tests**

Cover these exact outcomes:

```js
// Partial useful output: retain valid character, report setting validation
// outcome, and do not start Segmented fallback.
assertEqual(result.usefulCards.length, 1);
assertEqual(segmentedFallbackCalls.length, 0);

// Zero useful output after the Fused attempt window: start one fallback wave.
assertEqual(fusedCalls.length, 2);
assertEqual(segmentedFallbackCalls.length, 2); // one per selected card
assertEqual(arbiterCalls.length, 0); // this adapter receives an existing Arbiter artifact
```

- [ ] **Step 4: Run the narrow tests and verify red**

Run:

```powershell
node tools/scripts/test-settings.mjs
node tools/scripts/test-ui-view-model.mjs
node tools/scripts/test-pipeline-segmented.mjs
node tools/scripts/test-pipeline-fused.mjs
node tools/scripts/test-preprocess-graph.mjs
```

Expected: old `standard` labels/defaults and monolithic pipeline functions fail the new assertions.

- [ ] **Step 5: Rename the module/export and build Segmented stage adapters**

Move the Standard module, rename public exports, update imports, and make each card an adapter compatible with `createExecutionGraph`. Preserve current card prompt construction and validation behavior.

- [ ] **Step 6: Convert Fused to one executable parent with outcome children**

The Fused parent artifact must contain:

```js
{
    cards: { character: validCard },
    outcomes: {
        character: { state: 'completed', reason: null },
        setting: { state: 'failed', reason: 'invalid-card' },
    },
    fallback: null,
}
```

When no card is useful after the parent attempt window, return a scheduler graph expansion or explicit fallback directive that adds Segmented children using the same Arbiter checkpoint.

- [ ] **Step 7: Update pipeline setting normalization and view-model vocabulary**

Change default, label, standby text, and generic invalid fallback. Continue directly into Step 8 so Rapid is removed in the same migration task and the repository never retains a half-migrated pipeline enum.

- [ ] **Step 8: Remove Rapid runtime, warm state, and active test/proof paths**

Delete the three Rapid modules and remove:

- warm-run state and lifecycle methods;
- generation-ended warming hooks;
- Rapid roles and prompt builders;
- Rapid storage metadata/statuses;
- Rapid progress stages and pipeline menu/icon;
- Rapid-only test fixtures and proof-script branches.

Unknown persisted `rapid` remains only as an invalid settings value that reaches the generic enum fallback. Do not leave a `rapid` compatibility branch or no-op method.

- [ ] **Step 9: Update the refactor-hotspot audit**

Replace assertions that require `standard.mjs`/`rapid.mjs` imports with assertions for `segmented.mjs`, `fused.mjs`, and the scheduler modules. Add forbidden active identifiers:

```js
const forbidden = [
    'activeRapidWarmRun',
    'warmRapidScene',
    'rapidWarm',
    "pipelineMode === 'rapid'",
    "pipelineMode: 'rapid'",
];
```

- [ ] **Step 10: Run pipeline, vocabulary, runtime, storage, and audit tests**

Run:

```powershell
node tools/scripts/test-settings.mjs
node tools/scripts/test-ui-view-model.mjs
node tools/scripts/test-pipeline-segmented.mjs
node tools/scripts/test-pipeline-fused.mjs
node tools/scripts/test-preprocess-graph.mjs
node tools/scripts/test-runtime.mjs
node tools/scripts/test-storage.mjs
node tools/scripts/test-progress.mjs
node tools/scripts/test-ui.mjs
node tools/scripts/test-extension-smoke.mjs
node tools/scripts/audit-refactor-hotspots.mjs
rg -n -i "\brapid\b|rapidWarm|warmRapid|activeRapid" src --glob "!src/README.md"
```

Expected: all tests pass, active settings expose only Segmented and Fused, and the source scan returns no Rapid implementation identifiers.

- [ ] **Step 11: Commit the pipeline migration**

```powershell
git add -A src tools/scripts
git commit -m "refactor: replace rapid and standard pipelines"
```

---

### Task 6: Integrate Durable Pre-Process Lifecycle into Runtime and Host Events

**Files:**

- Modify: `src/runtime.mjs`
- Modify: `src/runtime/run-state.mjs`
- Modify: `src/runtime/prepared-generation.mjs`
- Modify: `src/runtime/prompt-install.mjs`
- Modify: `src/prompt.mjs`
- Modify: `src/extension/index.js`
- Modify: `tools/scripts/test-runtime.mjs`
- Create: `tools/scripts/test-runtime-preprocess.mjs`
- Modify: `tools/scripts/test-prompt.mjs`
- Modify: `tools/scripts/test-extension-smoke.mjs`

**Interfaces:**

```js
runtime.restoreExecutionState();
runtime.pauseOperation({ reason });
runtime.resumeOperation({ operationId });
runtime.retryStage({ operationId, stageId });
runtime.queueStageReprocess({ stageId });
runtime.cancelQueuedStageReprocess({ stageId });
runtime.requestFreshNextGeneration();
runtime.clearFreshNextGeneration();
runtime.getView();
```

Runtime view additions:

```js
{
    execution: {
        operationId,
        phase,
        state,
        frontierStageIds,
        resumable,
        staleFields,
        stages,
    } | null,
    queuedReprocess: {
        mode: 'stage' | 'full-fresh',
        stageIds,
    } | null,
}
```

- Preparing a generation creates or consumes one persisted operation for the current chat.
- Snapshot, Arbiter, card pipeline, deck update, hand assembly, guidance composition, prepared packet, and prompt installation settlement are explicit stages.
- The prepared packet checkpoint may be resumed without repeating earlier model calls.
- Stop, chat change, and extension disposal pause rather than discard a running operation. An incompatible source/provider/settings change aborts active work and marks the manifest stale rather than pretending it is resumable.
- Restore loads state for the active chat but never starts work.
- A prompt-install failure preserves the prepared packet, clears partial installation, warns, and permits SillyTavern primary generation without Recursion.
- If the operation was paused before prompt-install settlement, Resume rechecks install settlement. A settled install failure is not repeatedly retried.
- Primary story generation remains outside scheduler retry policy.
- A queued stage or full-fresh intent is consumed only by the next user send/swipe preparation.
- A stale operation cannot Resume; the next generation may consume a stage reprocess starting at the earliest meaningful stage.

- [ ] **Step 1: Add failing runtime pause/resume tests**

Using a controllable provider in `tools/scripts/test-runtime-preprocess.mjs`, prove:

```js
const prepare = runtime.prepareForGeneration(hostEvent);
await provider.waitForCall('card.character');
await runtime.pauseOperation({ reason: 'user' });

assertEqual(runtime.getView().execution.state, 'paused');
assertEqual(repository.savedManifest.stageRecords['preprocess.arbiter'].state, 'completed');
assertEqual(repository.savedManifest.stageRecords['preprocess.cards.segmented.character'].state, 'pending');

const resumed = runtime.resumeOperation({ operationId: repository.savedManifest.operationId });
assertEqual(provider.callCount('arbiter'), 1);
provider.resolve('card.character', validCharacterCard);
await resumed;
assertEqual(repository.savedManifest.stageRecords['preprocess.cards.segmented.character'].state, 'completed');
```

Add cases for:

- reloading/restoring a paused manifest exposes Resume without executing;
- restoring a manifest persisted as `running` converts unfinished `running` stages to `pending`, marks the operation `paused`, and executes nothing;
- chat change pauses chat A and displays chat B's independent state;
- source edit marks chat A's run stale and hides Resume;
- two concurrent Segmented card calls both receive abort on Stop;
- successful sibling checkpoints survive the other sibling's stop/failure;
- Retry targets only the blocking failed stage and resets its attempt window;
- invalid required guidance consumes the next attempt as a correction request and pauses at `preprocess.guidance` after exhaustion instead of silently substituting raw evidence;
- duplicate host events do not duplicate execution;
- primary generation is never repeated by the scheduler.

- [ ] **Step 2: Add failing prepared-packet and prompt-install settlement tests**

Prove:

```js
assertEqual(provider.totalModelCalls, callsBeforeResume);
assertDeepEqual(await runtime.resumeOperation({ operationId }), {
    kind: 'prepared-packet',
    packet: expectedPacket,
});
```

For install failure:

```js
host.installPrompt.reject(new Error('host rejected prompt'));
const result = await runtime.prepareForGeneration(event);
assertEqual(result.continuePrimaryGeneration, true);
assertEqual(result.recursionPromptInstalled, false);
assert(repository.savedManifest.stageRecords['preprocess.packet'].checkpoint);
assertEqual(repository.savedManifest.stageRecords['preprocess.install'].state, 'failed');
assertEqual(host.clearPromptCalls, 1);
```

- [ ] **Step 3: Add failing queued reprocess runtime tests**

Cover:

- queueing completed `card.character` writes persisted intent and performs no model call;
- cancel removes the intent;
- next send binds the intent to the operation, and the selected stage's transition to `running` consumes it once;
- stopping before the selected stage starts leaves the intent queued;
- failure after selected-stage start does not silently requeue it and cannot fall back to the replaced checkpoint;
- queueing Arbiter subsumes child card queues;
- full fresh bypasses all checkpoints once and then clears;
- old artifacts remain readable until replacement checkpoints commit;
- `Reset Scene Cache` clears manifest, artifacts, queued intent, and prompt residue.
- an inapplicable queued stage id is cleared with one bounded notice and is not mapped to a different stage.

- [ ] **Step 4: Run runtime tests and verify red**

Run:

```powershell
node tools/scripts/test-runtime-preprocess.mjs
node tools/scripts/test-runtime.mjs
node tools/scripts/test-extension-smoke.mjs
```

Expected: pause currently discards/supersedes work, restore methods do not exist, and queue state is volatile.

- [ ] **Step 5: Replace volatile lifecycle authority with the scheduler**

Keep `createRuntimeRunState` for active controllers and host-generation observations only. The persisted manifest becomes execution truth. Remove volatile fields that duplicate persisted operation, attempt, or queued intent state.

Build the pre-process graph in this order:

```text
preprocess.snapshot
  -> preprocess.arbiter
  -> preprocess.cards.segmented.<family> children OR preprocess.cards.fused
  -> preprocess.deck
  -> preprocess.hand
  -> preprocess.guidance
  -> preprocess.packet
  -> preprocess.install
```

Snapshot, deck, hand, packet, and install bookkeeping are local/host stages and do not consume model attempts. Arbiter, card generation, Fused bundle generation, and guidance composition use scheduler-owned attempt windows. Refactor `src/prompt.mjs` so required guidance exposes build/validate/correction functions to the stage adapter instead of hiding a raw-evidence success fallback after model failure. Prompt installation revalidates host state but is not itself a model attempt.

- [ ] **Step 6: Implement explicit host-event pause and restore routing**

In `src/extension/index.js`:

```js
await runtime.pauseOperation({ reason: 'chat-changed' });
await runtime.handleChatChanged();
await runtime.restoreExecutionState();
```

Use equivalent pause calls for extension disposal. Source/provider/settings changes abort the active invocation and pass through runtime provenance validation so an incompatible manifest becomes `stale`. When host generation or native quiet rewriting is active, the unified Stop path calls SillyTavern's native Stop exactly once before settling the Recursion operation. `GENERATION_STOPPED` then records/reflects the paused boundary without recursively invoking Stop. None of these paths automatically calls Resume.

- [ ] **Step 7: Make prompt installation a settled, resumable stage**

Record a safe settlement artifact:

```js
{
    installed: false,
    settled: true,
    failureClass: 'host-install-rejected',
    continuePrimaryGeneration: true,
}
```

Do not persist prompt bodies in the manifest or diagnostics. Preserve the prepared packet artifact separately.

- [ ] **Step 8: Make queued and full-fresh intents durable and one-shot**

Use repository queued-intent methods. Queue actions never invoke providers. Bind the intent after a user send/swipe enters Recursion preparation, copy the minimal roots into `manifest.queuedStageIds`, and clear each persisted root atomically only when that selected stage transitions to `running`. If Stop/cancellation happens before that boundary, leave the intent queued.

- [ ] **Step 9: Extend current-chat reset**

`resetSceneCache` must abort active work, abandon the manifest, clear resume artifacts and queued intent, clear installed prompt residue, then run existing scene-cache cleanup.

- [ ] **Step 10: Run runtime integration tests**

Run:

```powershell
node tools/scripts/test-runtime-preprocess.mjs
node tools/scripts/test-runtime.mjs
node tools/scripts/test-prompt.mjs
node tools/scripts/test-extension-smoke.mjs
node tools/scripts/test-execution-scheduler.mjs
```

Expected: all pass with no duplicate model or host-generation calls.

- [ ] **Step 11: Commit durable pre-process lifecycle**

```powershell
git add src/runtime.mjs src/runtime/run-state.mjs src/runtime/prepared-generation.mjs src/runtime/prompt-install.mjs src/prompt.mjs src/extension/index.js tools/scripts/test-runtime.mjs tools/scripts/test-runtime-preprocess.mjs tools/scripts/test-prompt.mjs tools/scripts/test-extension-smoke.mjs
git commit -m "feat: make preprocess operations resumable"
```

---

### Task 7: Make Post-Process Guidance, Drafts, and Commit Resumable

**Files:**

- Modify: `src/post-process-runtime.mjs`
- Modify: `src/runtime.mjs`
- Modify: `src/hosts/sillytavern/host.mjs`
- Modify: `tools/scripts/test-post-process-runtime.mjs`
- Modify: `tools/scripts/test-host.mjs`
- Modify: `tools/scripts/test-runtime.mjs`

**Interfaces:**

```js
export function createPostProcessStages({
    mode,
    categories,
    sourceSnapshot,
    buildGuidanceRequest,
    buildRewriteRequest,
    validateRewrite,
    commit,
});

host.findPostProcessCommit({ operationId, commitId, sourceIdentity });
host.commitPostProcessResult({ operationId, commitId, sourceIdentity, text, mode });
```

- Unified graph:

```text
source-snapshot -> unified-guidance -> unified-rewrite -> host-commit
```

- Progressive graph for each selected category:

```text
source-snapshot
  -> category-guidance
  -> category-rewrite
  -> next category guidance
  -> next category rewrite
  -> host-commit
```

- Guidance and valid drafts are separate checkpoints.
- A failed rewrite never causes completed guidance to repeat on Resume/Retry.
- The latest valid progressive draft is persisted after every category.
- Commit is idempotent. Repeated Resume, repeated host event, or extension reload cannot append/replace twice.
- Terminal completion purges intermediate guidance and draft bodies after retaining final safe summaries and commit receipt.
- Stop pauses in-flight post-processing. It does not cancel and discard the operation.

- [ ] **Step 1: Add failing Unified resume tests**

In `tools/scripts/test-post-process-runtime.mjs`:

```js
await runtime.startPostProcess(unifiedInput);
guidanceProvider.resolve(validGuidance);
await rewriteProvider.waitForCall();
await runtime.pauseOperation({ reason: 'user' });

assert(repository.savedManifest.stageRecords['postprocess.unified.guidance'].checkpoint);
assertEqual(repository.savedManifest.stageRecords['postprocess.unified.rewrite'].state, 'pending');

await runtime.resumeOperation({ operationId });
assertEqual(guidanceProvider.calls.length, 1);
assertEqual(rewriteProvider.calls.length, 2);
```

The second rewrite call is the explicit Resume execution; it receives a fresh stage attempt window while reusing the guidance artifact.

- [ ] **Step 2: Add failing Progressive resume tests**

Prove:

- category A guidance/rewrite checkpoint;
- category B guidance checkpoint;
- category B rewrite pauses/fails;
- reload exposes Resume but starts nothing;
- Resume reuses A draft and B guidance;
- resulting commit uses the latest valid draft;
- category A never reruns.

- [ ] **Step 3: Add failing idempotent host commit tests**

In `tools/scripts/test-host.mjs`, call the same commit twice:

```js
const first = await host.commitPostProcessResult(commit);
const second = await host.commitPostProcessResult(commit);

assertEqual(first.applied, true);
assertEqual(second.applied, false);
assertEqual(second.reason, 'already-applied');
assertEqual(countMessagesWithCommitId(chat, commit.commitId), 1);
```

Also test replace mode and a reload where only the existing chat marker/receipt proves the commit already happened.

- [ ] **Step 4: Run post-process and host tests and verify red**

Run:

```powershell
node tools/scripts/test-post-process-runtime.mjs
node tools/scripts/test-host.mjs
```

Expected: current volatile `active`/`armed` lifecycle loses guidance/drafts on cancellation, and the new idempotent interface is absent.

- [ ] **Step 5: Convert post-process plans to scheduler stage adapters**

Route guidance and rewrite model calls through `runModelStageAttempts`. Remove the local hardcoded retry loops. Persist guidance and valid drafts through artifact storage; manifest summaries contain only hashes, lengths, category ids, and validation status.

- [ ] **Step 6: Add commit receipts and host-side duplicate detection**

Use a stable `commitId` derived from operation id and final artifact hash. Before mutation:

```js
const existing = await host.findPostProcessCommit({
    operationId,
    commitId,
    sourceIdentity,
});
if (existing) return { applied: false, reason: 'already-applied', receipt: existing };
```

After mutation, persist a receipt containing commit id, source identity, mutation mode, target message id/swipe id, final artifact hash, and timestamp. Do not store final prose in the receipt.

- [ ] **Step 7: Purge resume-only artifacts after terminal completion**

Once commit receipt persistence succeeds, delete guidance and intermediate draft artifacts. Keep the final scene cache/card artifacts governed by normal cache retention.

- [ ] **Step 8: Run post-process, host, runtime, and scheduler tests**

Run:

```powershell
node tools/scripts/test-post-process-runtime.mjs
node tools/scripts/test-host.mjs
node tools/scripts/test-runtime.mjs
node tools/scripts/test-execution-scheduler.mjs
```

Expected: all pass; repeated commit paths produce one host mutation.

- [ ] **Step 9: Commit resumable post-processing**

```powershell
git add src/post-process-runtime.mjs src/runtime.mjs src/hosts/sillytavern/host.mjs tools/scripts/test-post-process-runtime.mjs tools/scripts/test-host.mjs tools/scripts/test-runtime.mjs
git commit -m "feat: checkpoint postprocess execution"
```

---

### Task 8: Project Durable State into Contextual Progress Actions

**Files:**

- Modify: `src/progress.mjs`
- Modify: `src/ui/view-model.mjs`
- Modify: `src/ui/action-status.mjs`
- Modify: `src/ui.mjs`
- Modify: `styles/recursion.css`
- Modify: `tools/scripts/test-progress.mjs`
- Modify (created in Task 5): `tools/scripts/test-ui-view-model.mjs`
- Create: `tools/scripts/test-ui-actions.mjs`
- Create: `tools/scripts/test-ui-render.mjs`

**Interfaces:**

```js
export function progressFromExecution(execution, queuedReprocess);
export function actionForProgressStage({
    operation,
    stage,
    queuedReprocess,
});

// normalized action descriptor
{
    kind: 'stop' | 'resume' | 'retry' | 'reprocess' | 'cancel-reprocess',
    stageId,
    operationId,
    label,
    icon,
}
```

Action matrix:

| Row state | Eligible row | Action |
|---|---|---|
| Running frontier | Executable owner | Stop |
| Paused frontier | Executable owner | Resume |
| Blocking failed | Executable owner | Retry |
| Completed/cached | Executable owner | Reprocess |
| Queued | Executable owner | Cancel queued reprocess |
| Stale | Earliest meaningful executable row | Reprocess |
| Pending/blocked/skipped | Any | None |
| Fused validation child | Non-executable | None |
| Unified Post-process child detail | Non-owner | None |

- Selected rows retain their normal green completed or purple cached state. Only the 24px action control is cyan.
- Every icon-only control has `aria-label`, `title`, keyboard focus, and touch target behavior.
- Tooltips and accessible labels use the approved copy: `Stop and pause this operation`, `Resume from saved checkpoint`, `Retry this step`, `Reprocess from here on the next generation`, and `Cancel queued reprocess`.
- The row reserves one action slot, not a secondary expansion panel.
- Mobile does not add text labels or multiple horizontally competing controls.

- [ ] **Step 1: Add failing pure action-matrix tests**

In `tools/scripts/test-progress.mjs`, table-test every row above:

```js
assertDeepEqual(actionForProgressStage({
    operation: {
        operationId: 'run-a',
        state: 'paused',
        frontierStageIds: ['preprocess.cards.segmented.character'],
    },
    stage: {
        id: 'preprocess.cards.segmented.character',
        state: 'pending',
        executable: true,
    },
    queuedReprocess: null,
}), {
    kind: 'resume',
    stageId: 'preprocess.cards.segmented.character',
    operationId: 'run-a',
    label: 'Resume from saved checkpoint',
    icon: 'play',
});
```

Prove Segmented card children own actions, Fused validation children do not, the Fused parent does, Unified Post-process parent does, Progressive category rows do, and only one Stop appears for concurrent Segmented children.

- [ ] **Step 2: Add failing DOM/render tests**

Assert each actionable row renders exactly one:

```html
<button
    class="recursion-progress-action"
    data-recursion-progress-action="resume"
    data-stage-id="preprocess.cards.segmented.character"
    aria-label="Resume from saved checkpoint"
    title="Resume from saved checkpoint"
></button>
```

Assert non-actionable rows render a reserved action-slot span without a button, queued rows render the cancel action, and no row renders an expander or second action menu.

- [ ] **Step 3: Add failing event-delegation tests**

In `tools/scripts/test-ui-actions.mjs`, click each action kind and assert exactly one runtime method:

```js
stop       -> runtime.pauseOperation({ reason: 'user' })
resume     -> runtime.resumeOperation({ operationId })
retry      -> runtime.retryStage({ operationId, stageId })
reprocess  -> runtime.queueStageReprocess({ stageId })
cancel     -> runtime.cancelQueuedStageReprocess({ stageId })
```

Add keyboard activation and a stale-row reprocess case.

- [ ] **Step 4: Run progress/UI tests and verify red**

Run:

```powershell
node tools/scripts/test-progress.mjs
node tools/scripts/test-ui-view-model.mjs
node tools/scripts/test-ui-actions.mjs
node tools/scripts/test-ui-render.mjs
```

Expected: progress stages do not yet expose action descriptors and rows have no action button.

- [ ] **Step 5: Add pure execution-to-progress projection**

Normalize operation/stage state into the existing progress shape. The projector decides row ownership and action eligibility; `ui.mjs` only renders the descriptor and dispatches it.

- [ ] **Step 6: Render one compact contextual action slot**

Extend `createProgressRowShell` with one fixed action slot after metadata. Update it in place from `updateProgressRow` so live progress does not replace rows or lose focus.

- [ ] **Step 7: Add accessible icons and direct event delegation**

Reuse the existing icon vocabulary where possible:

- stop: square;
- resume: play;
- retry: rotate arrow;
- reprocess: branching/refresh arrow;
- cancel queued: x.

Use direct button actions. Do not require row expansion, confirmation flap, or a secondary menu.

- [ ] **Step 8: Add compact/mobile CSS**

In `styles/recursion.css`:

```css
.recursion-progress-action-slot {
    inline-size: 24px;
    block-size: 24px;
    flex: 0 0 24px;
}

.recursion-progress-action {
    inline-size: 24px;
    block-size: 24px;
    color: var(--recursion-cyan);
}
```

Preserve row colors and visible focus. At narrow widths, truncate reason/meta before shrinking the action target.

- [ ] **Step 9: Run progress/UI tests**

Run:

```powershell
node tools/scripts/test-progress.mjs
node tools/scripts/test-ui-view-model.mjs
node tools/scripts/test-ui-actions.mjs
node tools/scripts/test-ui-render.mjs
```

Expected: all pass; every executable row has zero or one contextual button.

- [ ] **Step 10: Commit contextual progress actions**

```powershell
git add src/progress.mjs src/ui/view-model.mjs src/ui/action-status.mjs src/ui.mjs styles/recursion.css tools/scripts/test-progress.mjs tools/scripts/test-ui-view-model.mjs tools/scripts/test-ui-actions.mjs tools/scripts/test-ui-render.mjs
git commit -m "feat: add contextual pipeline controls"
```

---

### Task 9: Expose Attempts Setting and Finalize Queued Language

**Files:**

- Modify: `src/runtime.mjs`
- Modify: `src/runtime/run-state.mjs`
- Modify: `src/ui.mjs`
- Modify: `src/ui/view-model.mjs`
- Modify: `src/settings.mjs`
- Modify: `styles/recursion.css`
- Modify: `tools/scripts/test-settings.mjs`
- Modify (created in Task 8): `tools/scripts/test-ui-render.mjs`
- Modify: `tools/scripts/test-runtime.mjs`

**Interfaces:**

UI contract:

```text
Label: Attempts per step
Helper: Total automatic model attempts for each Recursion step. Slow calls are not retried unless they fail.
Control: compact numeric input or stepper, min 1, max 5, default 2
Location: Advanced settings
```

- Pipeline menu already exposes only Segmented and Fused after Task 5.
- Fresh-next UI says `Queued`, never `armed`.

- [ ] **Step 1: Add failing UI setting and terminology tests**

Assert:

```js
assert(rendered.includes('Attempts per step'));
assert(rendered.includes('Total automatic model attempts for each Recursion step. Slow calls are not retried unless they fail.'));
assertEqual(screen.getByLabelText('Attempts per step').min, '1');
assertEqual(screen.getByLabelText('Attempts per step').max, '5');
assertEqual(readSettingsPatch().modelAttemptsPerStep, 2);
```

Add a source/render assertion that active UI output contains no `armed` lifecycle label and does contain `Segmented`, `Fused`, and `Queued`.

- [ ] **Step 2: Run targeted tests and verify red**

Run:

```powershell
node tools/scripts/test-settings.mjs
node tools/scripts/test-ui-render.mjs
node tools/scripts/test-runtime.mjs
```

Expected: attempts control is absent and fresh-next UI still uses `armed`.

- [ ] **Step 3: Add the Advanced attempts control**

Render and read the setting through the existing settings patch path:

```js
patch.modelAttemptsPerStep = clampInteger(
    controls.modelAttemptsPerStep.value,
    1,
    5,
    2,
);
```

Capture the normalized limit when each attempt window opens. Changing `modelAttemptsPerStep` or `pipelineMode` aborts incompatible active work, clears transient prompt state, and marks the manifest stale through normal provenance rules; it does not mutate a running window in place. A later compatible operation or explicit Retry with unchanged provenance opens a fresh window from the current normalized setting.

- [ ] **Step 4: Replace fresh-next `armed` copy with `Queued`**

Update accessible names, tooltips, activity summaries, view-model labels, and state names where user-facing or persisted. Use `queuedFullFresh` or `queuedReprocess`, not `armedFreshNext`. Emit the approved compact confirmations: `<Stage> queued for reprocessing.`, `Queued reprocessing canceled.`, `Operation paused. Completed work was saved.`, and `Resuming from <Stage>.`

- [ ] **Step 5: Run focused tests and a terminology scan**

Run:

```powershell
node tools/scripts/test-settings.mjs
node tools/scripts/test-ui-render.mjs
node tools/scripts/test-runtime.mjs
rg -n -i "\barmed\b" src styles tools/scripts
```

Expected:

- tests pass;
- no active lifecycle state, accessible label, tooltip, or confirmation uses `armed`;
- unrelated English uses are reviewed rather than mechanically renamed.

- [ ] **Step 6: Commit attempts UI and Queued terminology**

```powershell
git add src/runtime.mjs src/runtime/run-state.mjs src/ui.mjs src/ui/view-model.mjs src/settings.mjs styles/recursion.css tools/scripts/test-settings.mjs tools/scripts/test-ui-render.mjs tools/scripts/test-runtime.mjs
git commit -m "feat: expose pipeline attempt controls"
```

---

### Task 10: Reconcile Diagnostics, Privacy, Retention, and Cache Reset

**Files:**

- Modify: `src/runtime/diagnostics.mjs`
- Modify: `src/storage.mjs`
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-diagnostics.mjs`
- Modify: `tools/scripts/test-storage.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Create: `tools/scripts/test-execution-privacy.mjs`

**Interfaces:**

```js
export function summarizeExecutionForDiagnostics(manifest);
export function collectResumeArtifactReferences(manifest);
export function purgeTerminalResumeArtifacts({ repository, manifest });
```

Allowed diagnostics:

```js
{
    operationId,
    operationPhase,
    operationState,
    stageId,
    stageState,
    attemptCount,
    elapsedMs,
    failureClass,
    artifactHash,
    artifactBytes,
    staleFields,
}
```

Forbidden diagnostics/activity/journal/chat-marker content:

- prompt bodies;
- raw model responses;
- Arbiter JSON body;
- card/reference bodies;
- prepared packet/hand body;
- post-process guidance;
- progressive draft text;
- final generated prose copied solely for resume.

Stable bounded codes to test and document:

```text
operation-paused:user-stop
operation-paused:chat-changed
operation-stale:source-changed
stage-attempt-exhausted
stage-checkpoint-reused
stage-checkpoint-invalidated
stage-reprocess-queued
stage-reprocess-canceled
stage-reprocess-consumed
stage-reprocess-inapplicable
resume-checkpoint-restored
resume-artifact-missing
resume-commit-already-applied
fused-fallback-segmented
```

Retention:

- keep nonterminal current-chat manifests/artifacts;
- purge intermediate post-process guidance/drafts after successful commit;
- purge abandoned/stale artifacts according to the existing cache retention pass;
- remove unreferenced/orphaned artifacts during repair;
- current-chat `Reset Scene Cache` clears all execution state immediately.

- [ ] **Step 1: Add a canary-based privacy test**

In `tools/scripts/test-execution-privacy.mjs`, persist artifacts containing unique canaries:

```js
const secrets = [
    'CANARY_ARBITER_BODY',
    'CANARY_CARD_BODY',
    'CANARY_PACKET_BODY',
    'CANARY_GUIDANCE_BODY',
    'CANARY_DRAFT_BODY',
];
```

Create activity, diagnostics export, run journal, manifest, queued intent, and chat marker representations. Assert every secret is absent from all except the dedicated artifact reads.
Assert each lifecycle transition above emits its stable code with ids/timings/counts only.

- [ ] **Step 2: Add failing terminal-purge and reset tests**

Prove:

- completed post-process commit deletes guidance and intermediate drafts;
- final commit receipt remains;
- paused operation survives ordinary retention;
- abandoned operation expires under retention;
- repair deletes an unreferenced pipeline artifact;
- retired Rapid warm records are ignored and removed by normal bounded-storage repair/pruning rather than migrated;
- Reset Scene Cache immediately removes current-chat manifest, artifacts, queued intent, and prompt residue.

- [ ] **Step 3: Run privacy/retention tests and verify red**

Run:

```powershell
node tools/scripts/test-execution-privacy.mjs
node tools/scripts/test-diagnostics.mjs
node tools/scripts/test-storage.mjs
node tools/scripts/test-runtime.mjs
```

Expected: execution summaries/purge behavior are not yet fully enforced.

- [ ] **Step 4: Implement allowlist-only execution diagnostics**

Build diagnostics from explicit fields. Never serialize the manifest wholesale:

```js
return {
    operationId: manifest.operationId,
    operationPhase: manifest.phase,
    operationState: manifest.state,
    stages: Object.values(manifest.stageRecords).map(summarizeStage),
    staleFields: [...(manifest.staleFields ?? [])],
};
```

- [ ] **Step 5: Implement terminal and retention purge**

Collect artifact references still required by reusable cache/checkpoints. Delete intermediate resume-only artifacts only after terminal receipt persistence. Extend repair to remove artifact index entries not referenced by a live manifest.

- [ ] **Step 6: Run privacy/retention tests**

Run:

```powershell
node tools/scripts/test-execution-privacy.mjs
node tools/scripts/test-diagnostics.mjs
node tools/scripts/test-storage.mjs
node tools/scripts/test-runtime.mjs
```

Expected: all pass and canaries appear only in dedicated artifact storage.

- [ ] **Step 7: Commit privacy and retention reconciliation**

```powershell
git add src/runtime/diagnostics.mjs src/storage.mjs src/runtime.mjs tools/scripts/test-diagnostics.mjs tools/scripts/test-storage.mjs tools/scripts/test-runtime.mjs tools/scripts/test-execution-privacy.mjs
git commit -m "fix: isolate resumable execution artifacts"
```

---

### Task 11: Update Current Documentation and Acceptance Coverage

**Files:**

- Modify: `README.md`
- Modify: `DESIGN.md`
- Modify: `src/README.md`
- Modify: `docs/DOCUMENTATION_INDEX.md`
- Modify: `docs/RECURSION_EXTENSION_SPEC.md`
- Modify: `docs/architecture/CACHE_USE_AND_REUSE_SPEC.md`
- Modify: `docs/architecture/POST_PROCESS_CARDS_RUNTIME.md`
- Modify: `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`
- Modify: `docs/architecture/RUNTIME_ARCHITECTURE.md`
- Modify: `docs/architecture/STORAGE_AND_DIAGNOSTICS.md`
- Modify: `docs/design/BEHAVIOR_SETTINGS_POLICY_SPEC.md`
- Modify: `docs/design/UI_SPEC.md`
- Modify: `docs/technical/HOST_INTEGRATION_MANUAL.md`
- Modify: `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md`
- Modify: `docs/technical/RECURSION_COST_RESEARCH.md`
- Modify: `docs/technical/RECURSION_TECHNICAL_MANUAL.md`
- Modify: `docs/technical/RUNTIME_TURN_SEQUENCE.md`
- Modify: `docs/technical/STORAGE_AND_DIAGNOSTICS.md`
- Modify: `docs/testing/LIVE_SMOKE_TEST_PLAN.md`
- Modify: `docs/testing/TESTING_STRATEGY.md`
- Modify: `docs/user/PROVIDER_SETUP.md`
- Modify: `docs/user/RECURSION_OPERATOR_MANUAL.md`
- Modify: `tools/scripts/test-alpha-gate.mjs`
- Modify: `tools/scripts/run-alpha-gate.mjs`

**Interfaces:**

Documentation contract:

- Explain Segmented as independent, simple per-card calls suitable for smaller/local models.
- Explain Fused as one bundle call with validation outcomes and Segmented fallback when it yields zero useful cards.
- Explain no default generation timeout, bounded automatic attempts per stage, and manual pause/resume/retry.
- Explain checkpoints, dependency-aware next-generation reprocessing, one-shot full fresh, queued behavior, stale runs, and current-chat reset.
- Explain that only model stages consume attempt windows.
- Explain that primary SillyTavern story generation is not auto-retried.
- Explain artifact privacy and terminal cleanup at an appropriate user-facing level.
- Preserve the text-light design contract: progress rows use a single contextual icon action, direct interaction, concise tooltip, and mobile-safe 24px slot.
- Mark older design records as superseded where necessary; do not rewrite historical decision context into false current behavior.

- [ ] **Step 1: Make acceptance/audit assertions fail**

Add current-contract assertions in `tools/scripts/test-alpha-gate.mjs`:

```js
assert(currentDocs.includes('Segmented'));
assert(currentDocs.includes('Fused'));
assert(currentDocs.includes('Attempts per step'));
assert(currentDocs.includes('Queued'));
assert(!activeDocs.includes('Rapid pipeline'));
assert(!activeDocs.includes('Standard pipeline'));
```

Also assert the settings example uses:

```json
{
  "pipelineMode": "segmented",
  "modelAttemptsPerStep": 2
}
```

- [ ] **Step 2: Run acceptance/doc audits and verify red**

Run:

```powershell
node tools/scripts/test-alpha-gate.mjs
```

Expected: current docs still describe old pipeline modes and lack resumable execution controls.

- [ ] **Step 3: Update the README and current runtime/settings docs**

Use the product vocabulary from the approved spec. Distinguish:

- automatic attempt within a stage;
- explicit Retry of a failed stage;
- Resume of a paused operation;
- Reprocess queued for the next generation;
- full fresh queued for the next generation.

Do not promise recovery after a provider has charged for a response that never reached Recursion.

- [ ] **Step 4: Update DESIGN.md and UI_SPEC.md**

Document the exact row action matrix, ownership rules, cyan action color, preserved green/purple row state, tooltip/ARIA requirements, one-button maximum, no row-expansion dependency, and narrow-screen truncation priorities.

- [ ] **Step 5: Mark superseded active design claims**

Search:

```powershell
rg -n -i "\bstandard\b|\brapid\b|\barmed\b|timeout|retry|fresh next" README.md DESIGN.md docs
```

For every match, either update current authority or explicitly label the document/section historical and superseded by the approved design. Do not alter the approved design spec except to correct a factual typo.

- [ ] **Step 6: Run documentation and alpha tests**

Run:

```powershell
node tools/scripts/test-alpha-gate.mjs
rg -n -i "\bstandard pipeline\b|\brapid pipeline\b|\barmed\b" README.md DESIGN.md docs
```

Expected: acceptance passes; remaining matches are only clearly historical/superseded records.

- [ ] **Step 7: Commit documentation**

```powershell
git add README.md DESIGN.md src/README.md docs tools/scripts/test-alpha-gate.mjs tools/scripts/run-alpha-gate.mjs
git commit -m "docs: document resumable pipeline controls"
```

---

### Task 12: Run Full Gates and Prove the Installed SillyTavern Path

**Files:**

- Modify only if a test exposes a defect: files owned by the task that introduced that defect
- Create: `docs/verification/2026-07-29-resumable-pipeline-execution.md`

**Interfaces:**

No new production interface is introduced in this task. The verification artifact uses this matrix:

| Scenario | Required proof |
|---|---|
| Slow provider | A controllable request remains pending while a fake monotonic clock advances beyond the former 120s boundary, until resolved or manually stopped; no real 120s test wait |
| Automatic attempt | One failed/invalid model attempt consumes one stage attempt and succeeds within configured limit |
| Pause | Running calls abort; completed checkpoints remain |
| Reload | Paused state and contextual Resume restore without executing |
| Retry | Only failed stage reruns with a fresh window |
| Reprocess | Completed stage queues with no immediate call; the next send binds it and selected-stage start consumes it once |
| Dependency reuse | Unchanged sibling/descendant checkpoints remain |
| Full fresh | Next send bypasses all checkpoints once |
| Segmented | Independent children survive sibling failure |
| Fused | Partial valid output survives; zero-useful result falls back once without rerunning Arbiter |
| Unified Post-process | Guidance survives rewrite interruption |
| Progressive Post-process | Latest valid draft/category guidance survives interruption |
| Commit | Duplicate Resume/event/reload creates one host mutation |
| Prompt install failure | Packet survives; prompt is cleared; primary generation continues |
| Reset Scene Cache | Current-chat manifest, artifacts, queue, and prompt residue clear |
| Privacy | Resume bodies exist only in artifact storage |
| Mobile UI | One 24px contextual action; text truncates first |

- [ ] **Step 1: Run every focused execution test**

Run:

```powershell
node tools/scripts/test-execution-contracts.mjs
node tools/scripts/test-execution-storage.mjs
node tools/scripts/test-execution-attempt-policy.mjs
node tools/scripts/test-execution-scheduler.mjs
node tools/scripts/test-queued-reprocess.mjs
node tools/scripts/test-execution-privacy.mjs
node tools/scripts/test-pipeline-segmented.mjs
node tools/scripts/test-pipeline-fused.mjs
node tools/scripts/test-runtime-preprocess.mjs
node tools/scripts/test-post-process-runtime.mjs
node tools/scripts/test-progress.mjs
node tools/scripts/test-ui-actions.mjs
node tools/scripts/test-host.mjs
```

Expected: every script exits 0.

- [ ] **Step 2: Run the full repository suite**

Run:

```powershell
npm.cmd test
```

Expected: every discovered test script passes.

- [ ] **Step 3: Run the alpha gate and static scans**

Run:

```powershell
node tools/scripts/test-alpha-gate.mjs
node tools/scripts/audit-refactor-hotspots.mjs
rg -n "120000|120_000|DEFAULT_PROVIDER_TIMEOUT|maxAttempts|allowStructuredRecovery" src
rg -n -i "\bstandard\b|\brapid\b|\barmed\b" src styles tools/scripts README.md DESIGN.md docs
```

Expected:

- gates pass;
- only the explicit provider diagnostic timeout remains;
- no hidden model-attempt loops remain;
- no active Standard/Rapid/armed product vocabulary remains.

- [ ] **Step 4: Inspect the final diff and working tree**

Run:

```powershell
git diff --check
git status --short
git diff --stat
git diff
```

Expected: no whitespace errors, no unrelated files, no generated secrets/artifact bodies, and only intended resumable-execution changes.

- [ ] **Step 5: Install the worktree copy into the designated SillyTavern test profile**

Use the repository's documented extension install/sync procedure. Exclude `.git`, `node_modules`, worktree metadata, test artifacts, and temporary files. Record the exact source commit and destination path in the verification document.

- [ ] **Step 6: Exercise the live SillyTavern scenarios**

In the installed copy:

1. Start a Segmented run with at least two card children.
2. Stop while a child call is pending.
3. Verify the row changes to paused with one Resume icon and retains completed purple/green checkpoints.
4. Reload SillyTavern and verify no call starts automatically.
5. Resume and confirm completed stages do not call the provider again.
6. Force one stage failure, use Retry, and confirm only that stage reruns.
7. Queue Reprocess on a completed stage, confirm no immediate call, then send/swipe and confirm one-shot consumption.
8. Queue/cancel reprocess and confirm cancellation.
9. Run Fused partial-output and zero-useful fallback fixtures.
10. Pause late Unified and Progressive post-processing and verify guidance/latest draft reuse.
11. Repeat the post-process completion event and verify one swipe/replace.
12. Trigger prompt-install failure and verify primary SillyTavern generation continues without a Recursion prompt.
13. Use Reset Scene Cache and verify the operation/queue controls disappear.
14. Inspect desktop and mobile-width progress rows for one action slot, accessible tooltip, and no horizontal overflow.

- [ ] **Step 7: Compare source and installed-copy hashes**

Hash every shipped extension file in the worktree and installed profile, excluding documented non-shipping paths. Record that the file sets and hashes match.

- [ ] **Step 8: Write the verification record**

Create `docs/verification/2026-07-29-resumable-pipeline-execution.md` with:

```markdown
# Resumable Pipeline Execution Verification

- Source commit:
- Installed profile:
- Installed-copy hash result:
- Focused tests:
- Full `npm.cmd test`:
- Alpha gate:
- Static scans:
- Live scenarios:
- Known limitations:
```

Include commands, timestamps, pass/fail outcomes, and concise evidence. Do not include provider keys, prompts, raw model results, cards, packets, or generated prose.

- [ ] **Step 9: Re-run affected tests after any live-test correction**

If live testing required a code correction, rerun its narrow test, the full suite, alpha gate, static scans, installed-copy sync, hash comparison, and affected live scenario before claiming completion.

- [ ] **Step 10: Commit verification evidence**

```powershell
git add docs/verification/2026-07-29-resumable-pipeline-execution.md
git commit -m "test: verify resumable pipeline execution"
```

- [ ] **Step 11: Finish the branch only after all evidence is green**

Invoke `superpowers:verification-before-completion`, then `superpowers:requesting-code-review`, address verified findings, rerun all affected gates, and finally invoke `superpowers:finishing-a-development-branch` to present integration options.
