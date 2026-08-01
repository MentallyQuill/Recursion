# Turn-Scoped Reuse And Host-Owned Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make generated Recursion work reusable only within one exact user turn, preserve zero-model-call swipe rerolls for that turn, and keep Stop/Resume inside SillyTavern's native generation lifecycle.

**Architecture:** Introduce one hashed turn identity shared by manifests, checkpoints, prepared packets, queued reprocess intents, Post-process triggers, and diagnostics. The runtime atomically revokes the prior turn before starting a new user turn, while unchanged swipes may reinstall the completed packet or resume a compatible paused operation. Public Resume starts native SillyTavern generation and the normal interceptor performs the internal scheduler continuation; generated scene-cache records cease to be reuse authority.

**Tech Stack:** JavaScript ES modules, Node.js script tests, Web Crypto SHA-256, Recursion's storage repository and execution scheduler, SillyTavern extension and generation APIs, compact DOM/CSS UI, Playwright live proof, Git.

## Global Constraints

- Treat `docs/superpowers/specs/2026-08-01-turn-scoped-reuse-and-host-owned-resume-design.md` as the source of truth.
- Before visible UI edits, reread `DESIGN.md` and `docs/design/UI_SPEC.md` as required by `AGENTS.md`.
- A new pending or committed user message always creates a new turn, even when its text matches an earlier message.
- An unchanged latest-assistant swipe may reuse the completed Pre-process operation, cards, hand, guidance, and packet with zero Utility, Reasoner, Segmented, or Fused model calls.
- Build the turn key from the configured source band. An edit inside that band invalidates reuse; an edit outside it does not.
- Exclude the assistant response being rerolled from a latest-assistant swipe's Pre-process turn source.
- Do not add a scene-change classifier, semantic reuse judge, time-to-live, wall-clock lease, or turn-count lease.
- Generated cards, checkpoints, hand, guidance, packet, and prompt-install evidence never satisfy a different turn key.
- Persistent custom deck/card definitions, card scope, provider configuration, and user settings remain cross-turn configuration.
- Last Brief may remain visible as historical inspection data, but historical Last Brief storage must have no API path into generation.
- Reprocess and Full Fresh clicks start no provider call, prompt install, Post-process call, or SillyTavern generation.
- Consume Reprocess and Full Fresh only on the next unchanged swipe for the bound turn key.
- Use the canonical visible copy `Reprocess from here on the next swipe` and `Rebuild all Recursion work on the next swipe`.
- Contextual Stop for host-owned work must call the same `runtime.stopGeneration()` path as the compact-bar Stop button.
- Public Resume must call `host.generation.start()` with one of `normal`, `swipe`, or `regenerate`; it must not call the execution scheduler directly.
- Stop never restarts generation automatically.
- Preserve the existing quiet/internal-generation bypass.
- Treat this as a pre-alpha contract replacement. Reject V1 pipeline, checkpoint, queued-intent, and generated scene-cache records; do not add aliases or fallback reads.
- Persist hashes and bounded ids only in lifecycle diagnostics. Never persist raw transcript text, provider output, generated card bodies, hand/packet bodies, hidden reasoning, credentials, or stack traces in diagnostics.
- Follow Red-Green-Refactor for every behavior change. Run the named narrow test after each red and green step.
- Use deferred promises and call counters for concurrency and zero-model-call assertions. Do not wait for real provider latency.
- Run `npm.cmd test` before every task commit that changes shared runtime, storage, host, extension, progress, or UI code.
- Keep the installed `default-user` extension untouched until repository tests pass. Then copy production files only and verify exact parity before live proof.
- Commit each task independently before beginning the next task.

---

### Task 1: Define Turn Identity And V2 Execution Contracts

**Files:**

- Create: `src/runtime/turn-scope.mjs`
- Create: `tools/scripts/test-turn-scope.mjs`
- Modify: `src/execution/provenance.mjs`
- Modify: `src/execution/checkpoints.mjs`
- Modify: `tools/scripts/test-execution-contracts.mjs`

**Interfaces:**

```js
export const TURN_IDENTITY_SCHEMA = 'recursion.turnIdentity.v1';

export function normalizeNativeGenerationType(value);

export async function createTurnIdentity({
  snapshot,
  pendingUserMessage,
  generationType,
  swipeMessageId,
  retention,
  contracts
});

export function classifyGeneration({
  nativeGenerationType,
  pendingUserMessage,
  currentTurnKeyHash,
  storedTurnKeyHash,
  storedOperationState
});
```

`classifyGeneration()` returns one of `new-user-turn`, `same-turn-host-retry`, `same-turn-swipe`,
`edited-band-swipe`, `compatible-paused-same-turn`,
`incompatible-paused-operation`, or `new-host-generation`. Quiet requests are
filtered by the extension before classification.

`createTurnIdentity()` produces this JSON-safe shape:

```js
{
  schema: TURN_IDENTITY_SCHEMA,
  turnKeyHash: 'sha256',
  chatKey: 'chat-a',
  sourceBandHash: 'sha256',
  sourceBandLimit: 12,
  sourceBandMessageCount: 12,
  sourceWindowFirstMesId: '4',
  sourceWindowLastMesId: '15',
  pendingUserMessageId: '15',
  pendingUserTextHash: 'sha256',
  nativeGenerationType: 'normal',
  characterHash: 'character-hash',
  groupHash: '',
  contractHash: 'sha256'
}
```

`PIPELINE_RUN_SCHEMA` becomes `recursion.pipelineRun.v2` and `CHECKPOINT_SCHEMA` becomes `recursion.stageCheckpoint.v2`. V2 manifests add `turnKeyHash`, `sourceBandHash`, `hostOwned`, and `nativeGenerationType`. V2 provenance adds `turnKeyHash` and `sourceBandHash`; every generated Pre-process checkpoint must carry them.

- [ ] **Step 1: Write failing turn-identity tests**

Create `tools/scripts/test-turn-scope.mjs` with exact source-band cases:

```js
import {
  classifyGeneration,
  createTurnIdentity,
  normalizeNativeGenerationType
} from '../../src/runtime/turn-scope.mjs';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

const messages = Array.from({ length: 14 }, (_, index) => ({
  mesid: index + 1,
  role: index % 2 === 0 ? 'user' : 'assistant',
  text: `message-${index + 1}`,
  swipe_id: index % 2 === 0 ? undefined : 0,
  visible: true
}));
const snapshot = {
  chatKey: 'chat-a',
  latestMesId: 14,
  messages,
  characterHash: 'character-a',
  groupHash: ''
};
const contracts = {
  pipelineMode: 'segmented',
  attempts: 2,
  deckRevisionHash: 'deck-a',
  providerContractHash: 'provider-a',
  promptContractHash: 'prompt-a',
  schemaVersions: { pipelineRun: 2, checkpoint: 2, packet: 1 }
};

const first = await createTurnIdentity({
  snapshot,
  pendingUserMessage: { mesid: 13, text: 'message-13' },
  generationType: 'swipe',
  swipeMessageId: 14,
  retention: { sourceWindowMessages: 12, sourceWindowCharacters: 12000 },
  contracts
});
const outsideBandEdit = await createTurnIdentity({
  snapshot: {
    ...snapshot,
    messages: snapshot.messages.map((message) => (
      message.mesid === 1 ? { ...message, text: 'edited outside band' } : message
    ))
  },
  pendingUserMessage: { mesid: 13, text: 'message-13' },
  generationType: 'swipe',
  swipeMessageId: 14,
  retention: { sourceWindowMessages: 12, sourceWindowCharacters: 12000 },
  contracts
});
const insideBandEdit = await createTurnIdentity({
  snapshot: {
    ...snapshot,
    messages: snapshot.messages.map((message) => (
      message.mesid === 5 ? { ...message, text: 'edited inside band' } : message
    ))
  },
  pendingUserMessage: { mesid: 13, text: 'message-13' },
  generationType: 'swipe',
  swipeMessageId: 14,
  retention: { sourceWindowMessages: 12, sourceWindowCharacters: 12000 },
  contracts
});

assertEqual(first.turnKeyHash, outsideBandEdit.turnKeyHash, 'outside-band edit preserves turn identity');
assert(first.turnKeyHash !== insideBandEdit.turnKeyHash, 'inside-band edit changes turn identity');
assertEqual(first.sourceWindowLastMesId, '13', 'swiped assistant is excluded from Pre-process source');

const repeatedTextNewId = await createTurnIdentity({
  snapshot: { ...snapshot, latestMesId: 15 },
  pendingUserMessage: { mesid: 15, text: 'message-13' },
  generationType: 'normal',
  retention: { sourceWindowMessages: 12, sourceWindowCharacters: 12000 },
  contracts
});
assert(first.turnKeyHash !== repeatedTextNewId.turnKeyHash, 'same text with a new message id is a new turn');
assertEqual(normalizeNativeGenerationType('regenerate'), 'regenerate');
assertEqual(normalizeNativeGenerationType('unknown'), 'normal');
assertEqual(classifyGeneration({
  nativeGenerationType: 'swipe',
  pendingUserMessage: null,
  currentTurnKeyHash: first.turnKeyHash,
  storedTurnKeyHash: first.turnKeyHash,
  storedOperationState: 'completed'
}).kind, 'same-turn-swipe');
```

- [ ] **Step 2: Run the new test and verify the red state**

Run: `node tools/scripts/test-turn-scope.mjs`

Expected: FAIL because `src/runtime/turn-scope.mjs` does not exist.

- [ ] **Step 3: Implement deterministic turn identity**

In `src/runtime/turn-scope.mjs`, use `selectBoundedSourceWindow()` and `stableHash()`; strip the assistant identified by `swipeMessageId` before bounding the swipe source. Hash message text before assembling the source-band record:

```js
const sourceBand = await Promise.all(bounded.messages.map(async (message, index) => ({
  messageId: String(message.mesid ?? message.id ?? index),
  role: normalizedRole(message),
  selectedSwipeId: String(message.swipe_id ?? message.swipeId ?? ''),
  textHash: await stableHash(String(message.mes ?? message.text ?? ''))
})));
const sourceBandHash = await stableHash(sourceBand);
const contractHash = await stableHash(contracts);
const turnKeyHash = await stableHash({
  chatKey,
  sourceBandLimit: retention.sourceWindowMessages,
  sourceBandMessageCount: sourceBand.length,
  sourceBand,
  pendingUserMessageId,
  pendingUserTextHash,
  characterHash,
  groupHash,
  contracts
});
```

Do not return source text from this module.

- [ ] **Step 4: Add V2 manifest, checkpoint, and provenance fields**

Change the schema constants and normalize the new fields without accepting V1:

```js
export const PIPELINE_RUN_SCHEMA = 'recursion.pipelineRun.v2';
export const CHECKPOINT_SCHEMA = 'recursion.stageCheckpoint.v2';

// createPipelineRun()/normalizePipelineRun()
turnKeyHash: cleanText(value.turnKeyHash),
sourceBandHash: cleanText(value.sourceBandHash),
hostOwned: value.hostOwned === true,
nativeGenerationType: ['normal', 'swipe', 'regenerate'].includes(value.nativeGenerationType)
  ? value.nativeGenerationType
  : 'normal'
```

Require `turnKeyHash` for generated Pre-process manifests and checkpoints. Add `turnKeyHash` and `sourceBandHash` to `normalizeExecutionProvenance()` and `buildRunProvenance()`.

- [ ] **Step 5: Run narrow contract tests**

Run: `node tools/scripts/test-turn-scope.mjs`

Expected: PASS.

Run: `node tools/scripts/test-execution-contracts.mjs`

Expected: PASS with V2 schema and turn-key provenance assertions.

- [ ] **Step 6: Run the full suite and commit**

Run: `npm.cmd test`

Expected: PASS after updating fixtures that intentionally construct pipeline manifests or checkpoints to include V2 turn metadata.

Commit:

```bash
git add src/runtime/turn-scope.mjs src/execution/provenance.mjs src/execution/checkpoints.mjs tools/scripts/test-turn-scope.mjs tools/scripts/test-execution-contracts.mjs
git commit -m "feat: define turn-scoped execution identity"
```

---

### Task 2: Replace Generated Scene-Cache Authority With Turn Storage

**Files:**

- Create: `src/storage/last-brief.mjs`
- Create: `tools/scripts/test-last-brief-storage.mjs`
- Modify: `src/storage.mjs`
- Modify: `tools/scripts/test-storage.mjs`
- Modify: `tools/scripts/test-execution-storage.mjs`

**Interfaces:**

```js
export const LAST_BRIEF_SCHEMA = 'recursion.lastBrief.v1';
export function lastBriefKey(chatKey);
export function normalizeLastBriefRecord(value);

// storage repository additions
repository.loadLastBrief(chatKey);
repository.saveLastBrief(chatKey, record);
repository.clearLastBrief(chatKey);
repository.revokeTurnExecution(chatKey, { operationId, reason });
repository.pruneRetiredGeneratedRecords();
```

The Last Brief record may contain sanitized display cards and final injected packet text because it is an explicit inspection record. It must use a separate key and repository methods that are never called by Pre-process stage input builders. Pipeline run keys and pipeline artifact keys move to `.v2.json`; the queued-intent key moves with its V2 envelope in Task 5. Legacy `recursion-scene-*.v1.json` records are recognized by the new pruning API only as deletion targets.

- [ ] **Step 1: Write failing storage authority tests**

Create `tools/scripts/test-last-brief-storage.mjs`:

```js
import {
  createMemoryStorageAdapter,
  createStorageRepository,
  lastBriefKey,
  pipelineRunKey
} from '../../src/storage.mjs';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

const adapter = createMemoryStorageAdapter();
const repository = createStorageRepository({ storage: adapter });
await repository.saveLastBrief('chat-a', {
  turnKeyHash: 'turn-a',
  status: 'historical',
  packet: { packetId: 'packet-a', prompt: 'Display-only packet text.' },
  hand: { cards: [{ id: 'card-a', promptText: 'Display-only card text.' }] },
  committedAt: '2026-08-01T12:00:00.000Z'
});
const brief = await repository.loadLastBrief('chat-a');
assertEqual(brief.schema, 'recursion.lastBrief.v1');
assertEqual(brief.turnKeyHash, 'turn-a');
assertEqual(pipelineRunKey('chat-a').endsWith('.v2.json'), true);

await adapter.writeJson('recursion-scene-chat-a-scene-a.v1.json', {
  recordType: 'recursion.sceneCache',
  cards: [{ promptText: 'retired generated card' }]
});
await repository.pruneRetiredGeneratedRecords();
assertEqual(await adapter.readJson('recursion-scene-chat-a-scene-a.v1.json'), null);
assert(await repository.loadLastBrief('chat-a'), 'retired generated cleanup preserves historical Last Brief');
```

- [ ] **Step 2: Run the new test and verify the red state**

Run: `node tools/scripts/test-last-brief-storage.mjs`

Expected: FAIL because Last Brief and retired-record APIs do not exist.

- [ ] **Step 3: Implement isolated Last Brief storage**

In `src/storage/last-brief.mjs`, normalize only this bounded display shape:

```js
{
  schema: LAST_BRIEF_SCHEMA,
  recordType: 'recursion.lastBrief',
  chatKey,
  turnKeyHash,
  status: 'ready' | 'historical',
  packet: sanitizedInspectionPacket,
  hand: sanitizedInspectionHand,
  committedAt
}
```

Reuse the existing card and packet sanitizers, cap arrays and strings to the same Last Brief limits used by the view model, and reject provider response fields, credentials, hidden reasoning, and stack data.

- [ ] **Step 4: Replace execution keys and add turn revocation**

Update `src/storage.mjs` so:

```js
pipelineRunKey('chat-a')
// recursion-pipeline-run-chat-a.v2.json

pipelineArtifactKey('chat-a', 'run-a', 'preprocess.arbiter')
// recursion-pipeline-artifact-chat-a-run-a-preprocess.arbiter.v2.json
```

Add a private legacy key matcher for `pruneRetiredGeneratedRecords()`. Implement `revokeTurnExecution()` by revoking eligibility first, then clearing the matching operation's artifacts, manifest, and queued intent; return bounded cleanup failures without restoring eligibility. Leave the old scene-cache methods available until Task 8 removes their remaining non-durable runtime call sites; the new turn-storage and Last Brief APIs must never call them.

- [ ] **Step 5: Run storage tests**

Run: `node tools/scripts/test-last-brief-storage.mjs`

Expected: PASS.

Run: `node tools/scripts/test-execution-storage.mjs`

Expected: PASS with V2 keys, exact turn revocation, and no artifact-body leakage.

Run: `node tools/scripts/test-storage.mjs`

Expected: PASS with new legacy-record pruning, Last Brief isolation, and turn-artifact cleanup cases while existing scene-cache cases remain green until final call-site retirement in Task 8.

- [ ] **Step 6: Run the full suite and commit**

Run: `npm.cmd test`

Expected: PASS.

Commit:

```bash
git add src/storage.mjs src/storage/last-brief.mjs tools/scripts/test-last-brief-storage.mjs tools/scripts/test-storage.mjs tools/scripts/test-execution-storage.mjs
git commit -m "refactor: replace scene cache with turn storage"
```

---

### Task 3: Normalize Host Generation Input And Empty Placeholders

**Files:**

- Modify: `src/extension/index.js`
- Modify: `tools/scripts/test-extension-smoke.mjs`

**Interfaces:**

```js
export function latestPendingUserMessageFromPayload(chat);

// result
{ text: 'user text', mesid: 32 } | null
```

- [ ] **Step 1: Add the empty-assistant-placeholder regression test**

Add to `tools/scripts/test-extension-smoke.mjs`:

```js
const payload = [
  { mesid: 31, is_user: false, mes: 'Prior assistant response.' },
  { mesid: 32, is_user: true, mes: 'Begin the next turn.' },
  { mesid: 33, is_user: false, mes: '' }
];
assertDeepEqual(
  latestPendingUserMessageFromPayload(payload),
  { text: 'Begin the next turn.', mesid: 32 },
  'empty assistant placeholder does not hide authoritative pending user input'
);
assertEqual(
  latestPendingUserMessageFromPayload([
    ...payload.slice(0, 2),
    { mesid: 33, is_user: false, mes: 'Completed assistant response.' }
  ]),
  null,
  'non-empty assistant response closes pending-user search'
);
```

- [ ] **Step 2: Run the extension test and verify the red state**

Run: `node tools/scripts/test-extension-smoke.mjs`

Expected: FAIL because the current helper stops at the empty assistant row.

- [ ] **Step 3: Fix payload normalization**

Export the helper for direct testing and use this reverse-scan rule:

```js
if (isSuppressedMessage(message)) continue;
const text = messageText(message);
if (!isRawUserChatMessage(message)) {
  if (!text) continue;
  return null;
}
if (text) return { text, mesid: messageMesId(message) };
return null;
```

Continue passing both the normalized user message and raw native `generationType` to `runtime.prepareForGeneration()`. Keep `quiet` bypass unchanged.

- [ ] **Step 4: Run tests and commit**

Run: `node tools/scripts/test-extension-smoke.mjs`

Expected: PASS.

Run: `npm.cmd test`

Expected: PASS.

Commit:

```bash
git add src/extension/index.js tools/scripts/test-extension-smoke.mjs
git commit -m "fix: preserve pending user behind placeholder"
```

---

### Task 4: Enforce Turn Boundaries And Same-Turn Swipe Reuse

**Files:**

- Modify: `src/runtime.mjs`
- Modify: `src/runtime/prepared-generation.mjs`
- Modify: `src/runtime/preprocess-graph.mjs`
- Modify: `src/runtime/run-state.mjs`
- Modify: `src/runtime/diagnostics.mjs`
- Modify: `tools/scripts/test-runtime-preprocess.mjs`
- Modify: `tools/scripts/test-prepared-generation.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `tools/scripts/test-diagnostics.mjs`
- Modify: `tools/scripts/test-execution-privacy.mjs`

**Interfaces:**

```js
async function revokePreviousTurn({ chatKey, storedManifest, nextTurnIdentity, reason });
async function continueDurablePreprocess({ manifest, graph, context });

// prepared generation V2 basis
{
  turnKeyHash,
  sourceBandHash,
  originatingUserMessageId,
  packetId,
  handId,
  contractHash
}
```

- [ ] **Step 1: Add failing runtime lifecycle cases**

Extend `tools/scripts/test-runtime-preprocess.mjs` with call-count assertions:

```js
const calls = [];
const { runtime, storage } = createHarness({ provider: immediateProvider(calls) });
await runtime.prepareForGeneration({
  userMessage: { text: 'I ask what she remembers.', mesid: 2 },
  hostGeneration: true,
  generationType: 'normal'
});
const firstManifest = await storage.loadPipelineRun('chat-preprocess');
const firstCounts = roleCounts(calls);

await runtime.handleLatestAssistantSwipeRetry({ messageId: 3 });
await runtime.prepareForGeneration({
  userMessage: null,
  hostGeneration: true,
  generationType: 'swipe'
});
assertDeepEqual(roleCounts(calls), firstCounts, 'unchanged swipe performs zero Recursion model calls');
assertEqual(runtime.getView().execution.operationId, firstManifest.operationId, 'same-turn swipe retains operation');

await runtime.prepareForGeneration({
  userMessage: { text: 'I ask what she remembers.', mesid: 4 },
  hostGeneration: true,
  generationType: 'normal'
});
const secondCounts = roleCounts(calls);
assertEqual(secondCounts.utilityArbiter, firstCounts.utilityArbiter + 1, 'new id reruns Arbiter despite repeated text');
assertEqual(await storage.loadQueuedReprocess('chat-preprocess'), null, 'new turn cancels prior queued intent');
```

Add separate cases for an edit inside the configured 12-message band, an edit outside it, corrupted prepared packet integrity, and a reload whose stored turn key no longer matches.

- [ ] **Step 2: Run runtime tests and verify the red state**

Run: `node tools/scripts/test-runtime-preprocess.mjs`

Expected: FAIL because completed and paused manifests are currently reused by broad provenance rather than explicit turn classification.

- [ ] **Step 3: Compute the turn identity before consulting durable storage**

In `prepareForGenerationDurable()`, create the turn identity immediately after building the snapshot:

```js
const turnIdentity = await createTurnIdentity({
  snapshot,
  pendingUserMessage,
  generationType,
  swipeMessageId: explicitSwipeMessageId,
  retention: settings.retention,
  contracts: durableTurnContracts(settings)
});
```

For swipes, derive `explicitSwipeMessageId` from the consumed
`pendingLatestAssistantSwipeRetry` marker when available, otherwise from the
current latest visible assistant identity. Do not infer it from an empty
assistant placeholder.

Pass `turnIdentity` into `createDurablePreprocessContext()`, `executionProvenance()`, the prepared-generation basis, and `createPipelineRun()`.

- [ ] **Step 4: Revoke the old turn before new provider work**

When `storedManifest.turnKeyHash !== turnIdentity.turnKeyHash`:

```js
await markManifestIneligibleFirst(storedManifest, {
  state: 'abandoned',
  pauseReason: 'new-user-turn',
  staleChangedFields: ['turnKeyHash']
});
clearPreparedGeneration();
clearPendingLatestAssistantSwipeRetry();
await clearPromptBestEffort(host);
await storage.revokeTurnExecution(chatKey, {
  operationId: storedManifest.operationId,
  reason: 'new-user-turn'
});
queuedReprocessView = null;
```

Perform this before `startDurableGraph()` or any provider call. Cleanup failure emits a bounded warning and does not restore the old manifest to eligibility.

- [ ] **Step 5: Remove generated scene-cache input and output from durable Pre-process**

Set `initialCache: null` for every new turn. Restore artifacts only through a matching V2 manifest and its checkpoint references. Remove durable-path calls to `loadSceneCacheSafe()`, `sceneCachePayload()`, and `saveSceneCacheSafe()`. On successful packet install, save Last Brief through `storage.saveLastBrief()` and mark an older visible Last Brief `historical` when the next turn begins.

- [ ] **Step 6: Gate exact swipe reuse by turn identity**

Update `tryPreparedGenerationReuse()` and `preparedGenerationMatches()` so `turnKeyHash`, `sourceBandHash`, packet integrity, settings contract, and prompt contract must all match. Only `generationType === 'swipe'` may use the zero-model-call completed-result path. A normal send always enters new-turn handling.

Expose only `turnKeyHash`, source-band limit/count/first/last ids, generation classification, operation metadata, and reuse/invalidation counts through diagnostics. Add the stable codes `new-user-turn`, `same-turn-swipe`, and `source-band-edited`; do not include the source-band message array or its text hashes in exported diagnostics.

- [ ] **Step 7: Run narrow tests**

Run: `node tools/scripts/test-runtime-preprocess.mjs`

Expected: PASS for new-turn revocation, same-turn swipe reuse, band edits, and reload staleness.

Run: `node tools/scripts/test-prepared-generation.mjs`

Expected: PASS with turn-key mismatch and corrupted-artifact rejection.

Run: `node tools/scripts/test-runtime.mjs`

Expected: PASS after replacing generated scene-cache expectations with turn-manifest and historical Last Brief expectations.

Run: `node tools/scripts/test-diagnostics.mjs`

Expected: PASS with bounded turn metadata and classification codes.

Run: `node tools/scripts/test-execution-privacy.mjs`

Expected: PASS and prove raw source/card/packet bodies remain absent.

- [ ] **Step 8: Run the full suite and commit**

Run: `npm.cmd test`

Expected: PASS.

Commit:

```bash
git add src/runtime.mjs src/runtime/prepared-generation.mjs src/runtime/preprocess-graph.mjs src/runtime/run-state.mjs src/runtime/diagnostics.mjs tools/scripts/test-runtime-preprocess.mjs tools/scripts/test-prepared-generation.mjs tools/scripts/test-runtime.mjs tools/scripts/test-diagnostics.mjs tools/scripts/test-execution-privacy.mjs
git commit -m "feat: enforce turn-scoped generation reuse"
```

---

### Task 5: Bind Reprocess And Full Fresh To The Next Matching Swipe

**Files:**

- Modify: `src/execution/queued-reprocess.mjs`
- Modify: `src/execution/scheduler.mjs`
- Modify: `src/runtime.mjs`
- Modify: `src/post-process-runtime.mjs`
- Modify: `src/storage.mjs`
- Modify: `tools/scripts/test-queued-reprocess.mjs`
- Modify: `tools/scripts/test-execution-scheduler.mjs`
- Modify: `tools/scripts/test-execution-storage.mjs`
- Modify: `tools/scripts/test-runtime-preprocess.mjs`
- Modify: `tools/scripts/test-diagnostics.mjs`
- Modify: `tools/scripts/test-execution-privacy.mjs`

**Interfaces:**

```js
export const QUEUED_REPROCESS_SCHEMA = 'recursion.queuedReprocess.v2';

// normalized intent
{
  schema: QUEUED_REPROCESS_SCHEMA,
  mode: 'stage' | 'full-fresh',
  chatKey: 'chat-a',
  phase: 'preprocess' | 'postprocess',
  turnKeyHash: 'turn-a',
  stageIds: ['preprocess.arbiter'],
  queuedAt: '2026-08-01T12:00:00.000Z'
}

runtime.queueStageReprocess({ operationId, stageId });
runtime.cancelQueuedStageReprocess({ operationId, stageId });
runtime.queueFullFreshSwipe({ source: 'bar' });
runtime.clearQueuedFullFreshSwipe();
```

- [ ] **Step 1: Write failing intent-binding tests**

Update `tools/scripts/test-queued-reprocess.mjs`:

```js
const intent = normalizeQueuedReprocess({
  schema: 'recursion.queuedReprocess.v2',
  mode: 'stage',
  chatKey: 'chat-a',
  phase: 'preprocess',
  turnKeyHash: 'turn-a',
  stageIds: ['preprocess.cards.segmented.character'],
  queuedAt: '2026-08-01T12:00:00.000Z'
});
assertEqual(intent.turnKeyHash, 'turn-a');
assertEqual(normalizeQueuedReprocess({
  ...intent,
  schema: 'recursion.queued-reprocess.v1'
}), null, 'V1 unbound intent is rejected');
assertEqual(bindQueuedReprocess({
  intent,
  graph,
  manifest: { ...manifest, turnKeyHash: 'turn-b' },
  provenance
}).reason, 'turn-key-mismatch');
```

Add runtime cases proving a stage click causes zero calls, a normal new send cancels the intent, an edited-band swipe cancels it, an unchanged swipe consumes it once, and Full Fresh reruns every requested model stage only on an unchanged swipe.

- [ ] **Step 2: Run queued-intent tests and verify the red state**

Run: `node tools/scripts/test-queued-reprocess.mjs`

Expected: FAIL because V1 intents lack chat, phase, and turn binding.

- [ ] **Step 3: Implement V2 intent normalization and merge rules**

Require exact `chatKey`, `phase`, `turnKeyHash`, and `queuedAt`. Merge only intents with equal binding fields. Preserve ancestor subsumption within one phase; never merge Pre-process and Post-process stage ids into one phase record.

Store phase intents as separate records under the chat's queued-intent V2 envelope:

```js
{
  schema: 'recursion.queuedReprocessEnvelope.v2',
  chatKey: 'chat-a',
  preprocess: intentOrNull,
  postprocess: intentOrNull
}
```

- [ ] **Step 4: Restrict consumption to matching swipes**

Before `bindDurableQueuedIntent()`:

```js
if (generationClassification.kind !== 'same-turn-swipe') {
  if (generationClassification.kind === 'new-user-turn'
      || generationClassification.kind === 'edited-band-swipe') {
    await cancelBoundIntent('queued-reprocess-canceled-new-turn');
  }
  // A normal generation never consumes a queued swipe intent.
} else if (intent.turnKeyHash === turnIdentity.turnKeyHash) {
  await bindDurableQueuedIntent(...);
}
```

Consume the intent only after its selected executable root starts. Preserve valid ancestors and unrelated siblings; scheduler dependency-hash validation reruns descendants whose inputs changed.

- [ ] **Step 5: Replace Full Fresh next-generation APIs**

Remove `requestFreshNextGeneration()` and `clearFreshNextGeneration()`. Implement `queueFullFreshSwipe()` and `clearQueuedFullFreshSwipe()` as the root-level V2 Pre-process intent. It is visible only when a completed active turn exists. It never applies to a normal send.

- [ ] **Step 6: Preserve Post-process intent until the new response exists**

Keep a matching Post-process intent queued while the native swipe generates. Once the new assistant response identity is available, rebuild `postprocess.source-snapshot` for that response, invalidate the selected Post-process stage and descendants, and consume the intent when its root starts.

- [ ] **Step 7: Run narrow tests**

Run: `node tools/scripts/test-queued-reprocess.mjs`

Expected: PASS.

Run: `node tools/scripts/test-execution-scheduler.mjs`

Expected: PASS with ancestor/sibling checkpoint rules unchanged.

Run: `node tools/scripts/test-execution-storage.mjs`

Expected: PASS with separate V2 phase intents and no artifact bodies.

Run: `node tools/scripts/test-runtime-preprocess.mjs`

Expected: PASS for click-without-work, next-swipe consumption, new-turn cancellation, and Full Fresh behavior.

Run: `node tools/scripts/test-diagnostics.mjs`

Expected: PASS with bounded queued stage ids, bound turn hash, and consume/cancel reason codes.

Run: `node tools/scripts/test-execution-privacy.mjs`

Expected: PASS with V2 queued intent metadata and no artifact bodies.

- [ ] **Step 8: Run the full suite and commit**

Run: `npm.cmd test`

Expected: PASS.

Commit:

```bash
git add src/execution/queued-reprocess.mjs src/execution/scheduler.mjs src/runtime.mjs src/post-process-runtime.mjs src/storage.mjs tools/scripts/test-queued-reprocess.mjs tools/scripts/test-execution-scheduler.mjs tools/scripts/test-execution-storage.mjs tools/scripts/test-runtime-preprocess.mjs tools/scripts/test-diagnostics.mjs tools/scripts/test-execution-privacy.mjs
git commit -m "feat: bind reprocessing to matching swipes"
```

---

### Task 6: Route Unified Stop And Resume Through Native Generation

**Files:**

- Modify: `src/runtime.mjs`
- Modify: `src/ui/action-status.mjs`
- Modify: `src/hosts/sillytavern/host.mjs`
- Modify: `tools/scripts/test-runtime-preprocess.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `tools/scripts/test-ui-actions.mjs`
- Modify: `tools/scripts/test-host.mjs`
- Modify: `tools/scripts/test-diagnostics.mjs`
- Modify: `tools/scripts/test-execution-privacy.mjs`

**Interfaces:**

```js
runtime.stopGeneration({ source: 'recursion-progress-row' });
runtime.resumeOperation({ operationId }); // public host-owned Resume

// private runtime continuation used by prepareForGenerationDurable()
continuePausedPreprocess({ operationId, graph, context, manifest });
```

- [ ] **Step 1: Make contextual Stop fail against the old dispatch path**

Change the expected UI action in `tools/scripts/test-ui-actions.mjs`:

```js
['stop', 'stopGeneration', { source: 'recursion-progress-row' }]
```

Add a `stopGeneration()` fake and remove the Stop expectation for `pauseOperation()`.

Run: `node tools/scripts/test-ui-actions.mjs`

Expected: FAIL because Stop currently calls `pauseOperation({ reason: 'user' })`.

- [ ] **Step 2: Add host-owned Resume regression tests**

In `tools/scripts/test-runtime-preprocess.mjs`, pause a `nativeGenerationType: 'swipe'` operation, then assert:

```js
const resume = await runtime.resumeOperation({ operationId: paused.operationId });
assertEqual(resume.started, true);
assertDeepEqual(hostGenerationStarts, [{
  type: 'swipe',
  source: 'recursion-ui',
  reason: 'resume-operation'
}]);
assertEqual(providerCalls.length, callsBeforeResume, 'Resume click starts no detached provider work');

await runtime.prepareForGeneration({
  userMessage: null,
  hostGeneration: true,
  generationType: 'swipe'
});
assertEqual(cardCalls, callsBeforeResume + 1, 'interceptor resumes pending card exactly once');
```

Add a host-start failure case that returns `ok: false`, leaves the manifest paused, records `host-resume-start-failed`, and makes zero provider calls.

- [ ] **Step 3: Route contextual Stop through unified cleanup**

Change `dispatchProgressAction()`:

```js
if (source.kind === 'stop') {
  return runtime?.stopGeneration?.({ source: 'recursion-progress-row' });
}
```

In `runtime.stopGeneration()`, memoize one in-flight cleanup promise. The promise must pause durable work, abort provider work, cancel Post-process, request native Stop, clear prompt lanes, and settle the stop journal once. Both the UI call and `GENERATION_STOPPED` event await or observe the same cleanup.

- [ ] **Step 4: Split public Resume from scheduler continuation**

Move the existing scheduler body of `resumeOperation()` into private `continuePausedPreprocess()`. Public `resumeOperation()` validates `hostOwned`, `turnKeyHash`, paused state, and native generation type, then calls:

```js
return requestHostGenerationStart({
  type: manifest.nativeGenerationType,
  source: 'recursion-ui',
  reason: 'resume-operation'
});
```

Do not mutate the manifest before `generation.start()` reports success.

- [ ] **Step 5: Auto-claim a compatible paused operation in the interceptor**

In `prepareForGenerationDurable()`, when classification is `compatible-paused-same-turn`, call `continuePausedPreprocess()` within the active host generation instead of returning `durableOperationResult()`. A native SillyTavern Swipe/Regenerate/Send therefore follows the same resume path as the progress-row Resume button.

- [ ] **Step 6: Run narrow tests**

Run: `node tools/scripts/test-ui-actions.mjs`

Expected: PASS.

Run: `node tools/scripts/test-host.mjs`

Expected: PASS for `generation.start()` and `generation.stop()` success/unavailable contracts.

Run: `node tools/scripts/test-runtime-preprocess.mjs`

Expected: PASS for native Resume ownership, failure-without-provider-work, compatible auto-resume, and new-turn abandonment.

Run: `node tools/scripts/test-runtime.mjs`

Expected: PASS with one stop request, one prompt clear, and idempotent host-event cleanup.

Run: `node tools/scripts/test-diagnostics.mjs`

Expected: PASS with `operation-paused-user-stop` and `host-resume-start-failed` codes.

Run: `node tools/scripts/test-execution-privacy.mjs`

Expected: PASS with native generation type and no host/provider error bodies.

- [ ] **Step 7: Run the full suite and commit**

Run: `npm.cmd test`

Expected: PASS.

Commit:

```bash
git add src/runtime.mjs src/ui/action-status.mjs src/hosts/sillytavern/host.mjs tools/scripts/test-runtime-preprocess.mjs tools/scripts/test-runtime.mjs tools/scripts/test-ui-actions.mjs tools/scripts/test-host.mjs tools/scripts/test-diagnostics.mjs tools/scripts/test-execution-privacy.mjs
git commit -m "fix: keep stop and resume host-owned"
```

---

### Task 7: Enforce Per-Response Post-Process Ownership

**Files:**

- Modify: `src/post-process-runtime.mjs`
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-post-process-runtime.mjs`
- Modify: `tools/scripts/test-runtime-preprocess.mjs`

**Interfaces:**

```js
postProcessRuntime.preparePostProcessTrigger({
  preprocessTurnKeyHash,
  preGenerationSourceIdentity,
  generationType
});

// post-process provenance additions
{
  preprocessTurnKeyHash,
  responseIdentityHash,
  nativeGenerationType
}
```

- [ ] **Step 1: Write failing response-boundary tests**

Add to `tools/scripts/test-post-process-runtime.mjs`:

```js
const first = await runPostProcess({
  preprocessTurnKeyHash: 'turn-a',
  response: { messageId: 12, swipeId: 0, text: 'first response' }
});
const second = await runPostProcess({
  preprocessTurnKeyHash: 'turn-a',
  response: { messageId: 12, swipeId: 1, text: 'second response' }
});
assert(first.execution.provenance.responseIdentityHash
  !== second.execution.provenance.responseIdentityHash);
assertEqual(second.reusedResponseArtifactCount, 0, 'Post-process never reuses prior swipe body or rewrite');
```

Add a queued Post-process stage case proving it remains queued during Pre-process/native generation, then consumes once against the second response identity.

- [ ] **Step 2: Run the Post-process test and verify the red state**

Run: `node tools/scripts/test-post-process-runtime.mjs`

Expected: FAIL until response identity and parent turn identity are mandatory provenance.

- [ ] **Step 3: Add turn and response provenance**

Hash `{ messageId, swipeId, textHash }` for the newly landed assistant response. Require both `preprocessTurnKeyHash` and `responseIdentityHash` on Post-process manifests/checkpoints. Rebuild `postprocess.source-snapshot` for every new response identity even when the Pre-process turn key is unchanged.

- [ ] **Step 4: Bind queued Post-process work to the new response**

When a matching turn-bound Post-process intent exists, carry only its stage id across native generation. After response identity exists, create a new Post-process operation, invalidate the selected stage and descendants, and consume the intent at selected-stage start. Never carry response text, rewrite artifacts, or commit receipts from the prior swipe.

- [ ] **Step 5: Run tests and commit**

Run: `node tools/scripts/test-post-process-runtime.mjs`

Expected: PASS.

Run: `node tools/scripts/test-runtime-preprocess.mjs`

Expected: PASS and prove same-turn swipe Pre-process reuse still allows one fresh Post-process run.

Run: `npm.cmd test`

Expected: PASS.

Commit:

```bash
git add src/post-process-runtime.mjs src/runtime.mjs tools/scripts/test-post-process-runtime.mjs tools/scripts/test-runtime-preprocess.mjs
git commit -m "feat: bind post-process to response identity"
```

---

### Task 8: Retire The Non-Durable Scene Pipeline And Obsolete Cache Settings

**Files:**

- Modify: `src/extension/index.js`
- Modify: `src/runtime.mjs`
- Modify: `src/storage.mjs`
- Modify: `src/retention-policy.mjs`
- Modify: `src/settings.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `tools/scripts/test-runtime-preprocess.mjs`
- Modify: `tools/scripts/test-storage.mjs`
- Modify: `tools/scripts/test-retention-policy.mjs`
- Modify: `tools/scripts/test-settings.mjs`

**Interfaces:**

```js
createRecursionRuntime({
  host,
  settingsStore,
  storage,
  activity,
  generationRouter
});

runtime.resetTurnCache();
```

`durablePreprocess` is removed as an option because the V2 durable turn pipeline is the only production contract. The repository no longer exposes generated scene-cache load/save/invalidate methods. Retention settings contain only source-window, provider-analysis, and journal bounds.

- [ ] **Step 1: Write failing retirement assertions**

Update focused tests:

```js
const repository = createStorageRepository({ storage: createMemoryStorageAdapter() });
assertEqual(typeof repository.loadSceneCache, 'undefined');
assertEqual(typeof repository.saveSceneCache, 'undefined');
assertEqual(typeof repository.invalidateSceneCache, 'undefined');

const retention = normalizeRetentionSettings({
  sceneCachesPerChat: 9,
  sceneCachesTotal: 30,
  sourceVariantsPerScene: 8
});
assertEqual(Object.hasOwn(retention, 'sceneCachesPerChat'), false);
assertEqual(Object.hasOwn(retention, 'sceneCachesTotal'), false);
assertEqual(Object.hasOwn(retention, 'sourceVariantsPerScene'), false);

assertEqual(typeof runtime.resetTurnCache, 'function');
assertEqual(typeof runtime.resetSceneCache, 'undefined');
```

Add a runtime case that calls `createRecursionRuntime()` without `durablePreprocess`, prepares one normal turn, and proves a V2 pipeline manifest is created.

- [ ] **Step 2: Run focused tests and verify the red state**

Run: `node tools/scripts/test-storage.mjs`

Expected: FAIL because scene-cache repository methods still exist.

Run: `node tools/scripts/test-settings.mjs`

Expected: FAIL because obsolete retention settings are still normalized.

Run: `node tools/scripts/test-runtime.mjs`

Expected: FAIL because the runtime default still selects the old non-durable coordinator.

- [ ] **Step 3: Make the durable turn pipeline unconditional**

Remove the `durablePreprocess` constructor argument and every branch that selects the prior scene pipeline. `prepareForGeneration()` always enters the V2 turn-classification and durable execution path. Remove the old non-durable preparation coordinator, its scene-cache load/save/invalidation helpers, and its fresh-next-generation run-state token. Keep shared card validation, prompt composition, provider routing, and Post-process helpers used by the durable graph.

Update `bootstrapRecursion()` to stop passing `durablePreprocess: true`; there is no alternate mode.

- [ ] **Step 4: Remove generated scene-cache repository authority**

Delete public `loadSceneCache`, `saveSceneCache`, `invalidateSceneCache`, `clearSceneCache`, and scene-cache retention methods. Keep only the private legacy-key matcher and deletion pass used by `pruneRetiredGeneratedRecords()`. Remove scene caches from the system-index record kinds after the pruning pass has deleted them.

Rename the destructive current-turn runtime action:

```js
async function resetTurnCache() {
  supersedeActiveRun();
  postProcessRuntime.cancelPostProcess('reset-turn-cache');
  await storage.revokeTurnExecution(activeExecutionChatKey, {
    operationId: executionView?.operationId,
    reason: 'reset-turn-cache'
  });
  clearPreparedGeneration();
  await clearPromptBestEffort(host);
  executionView = null;
  queuedReprocessView = null;
  return { ok: true };
}
```

- [ ] **Step 5: Remove obsolete retention settings**

Delete `sceneCachesPerChat`, `sceneCachesTotal`, and `sourceVariantsPerScene` from defaults, limits, normalization, reset behavior, and tests. Keep exactly:

```js
{
  sourceWindowMessages: 20,
  sourceWindowCharacters: 12000,
  providerVisibleMessages: 12,
  runJournalEntries: 100
}
```

Do not read or map the deleted names.

- [ ] **Step 6: Convert runtime tests to the one V2 coordinator**

Remove harness parameters that set `durablePreprocess: false`. Replace old scene-deck/cache reuse assertions with:

- V2 turn manifest/checkpoint assertions;
- same-turn prepared-packet reuse assertions;
- historical Last Brief isolation assertions;
- legacy generated-record pruning assertions.

Delete test fixtures whose only purpose was semantic scene-cache reuse, cross-turn cache variants, scene-shift leases, or A/B/A scene variants. Preserve card validation, prompt installation, provider failure, settings mutation, and Post-process behavior by driving those cases through V2 turn operations.

- [ ] **Step 7: Run focused tests**

Run: `node tools/scripts/test-runtime.mjs`

Expected: PASS with the V2 coordinator as the only path.

Run: `node tools/scripts/test-runtime-preprocess.mjs`

Expected: PASS.

Run: `node tools/scripts/test-storage.mjs`

Expected: PASS with Last Brief, V2 execution, legacy pruning, journals, and diagnostics but no scene-cache round trips.

Run: `node tools/scripts/test-retention-policy.mjs`

Expected: PASS with source-window and journal caps only.

Run: `node tools/scripts/test-settings.mjs`

Expected: PASS and prove deleted setting names are absent.

- [ ] **Step 8: Run the full suite and commit**

Run: `npm.cmd test`

Expected: PASS.

Run:

```powershell
rg -n "durablePreprocess|loadSceneCache|saveSceneCache|invalidateSceneCache|resetSceneCache|sceneCachesPerChat|sceneCachesTotal|sourceVariantsPerScene" src tools/scripts
```

Expected: no production or current-test matches; the legacy filename matcher may use `recursion-scene-` without exposing a load API.

Commit:

```bash
git add src/extension/index.js src/runtime.mjs src/storage.mjs src/retention-policy.mjs src/settings.mjs tools/scripts/test-runtime.mjs tools/scripts/test-runtime-preprocess.mjs tools/scripts/test-storage.mjs tools/scripts/test-retention-policy.mjs tools/scripts/test-settings.mjs
git commit -m "refactor: retire generated scene cache"
```

---

### Task 9: Update Compact UI Actions, Settings, And Vocabulary

**Files:**

- Modify: `DESIGN.md`
- Modify: `docs/design/UI_SPEC.md`
- Modify: `src/progress.mjs`
- Modify: `src/ui.mjs`
- Modify: `src/ui/view-model.mjs`
- Modify: `tools/scripts/test-progress.mjs`
- Modify: `tools/scripts/test-ui-actions.mjs`
- Modify: `tools/scripts/test-ui-render.mjs`
- Modify: `tools/scripts/test-ui.mjs`

**Interfaces and exact copy:**

```text
Reprocess from here on the next swipe
Cancel queued reprocess
Rebuild all Recursion work on the next swipe
Full rebuild on next swipe: Queued
Reset Turn Cache
```

`Reset Turn Cache` tooltip:

```text
Delete Recursion's generated work for the active turn without changing SillyTavern messages.
```

- [ ] **Step 1: Write failing UI-copy and dispatch assertions**

Update UI tests to require:

```js
assertEqual(reprocessButton.getAttribute('aria-label'), 'Reprocess from here on the next swipe');
assertEqual(fullFreshButton.getAttribute('aria-label'), 'Rebuild all Recursion work on the next swipe');
assertEqual(fullFreshButton.getAttribute('aria-pressed'), 'false');
assertEqual(resetButton.textContent, 'Reset Turn Cache');
assertEqual(root.querySelector('[data-recursion-setting-scene-caches-per-chat]'), null);
assertEqual(root.querySelector('[data-recursion-setting-scene-caches-total]'), null);
assertEqual(root.querySelector('[data-recursion-setting-source-variants-per-scene]'), null);
```

Retain one 24px contextual row action and existing Stop/Resume/Retry/Reprocess/cancel icon vocabulary.

- [ ] **Step 2: Run UI tests and verify the red state**

Run: `node tools/scripts/test-progress.mjs`

Expected: FAIL on old next-generation action labels.

Run: `node tools/scripts/test-ui.mjs`

Expected: FAIL on old Full Fresh, Reset Scene Cache, and retention-control copy.

- [ ] **Step 3: Update progress and bar controls**

Change action descriptors in `src/progress.mjs`, the compact-bar Full Fresh control in `src/ui.mjs`, and all associated `title`, `aria-label`, `aria-pressed`, transient status, and mobile status copy. Full Fresh remains in the idle command slot and is hidden whenever active Stop owns that slot.

- [ ] **Step 4: Remove scene-cache settings and rename reset**

Remove the three obsolete retention number controls and their read/write bindings. Retain source-window, provider-analysis, and journal controls. Rename the runtime UI binding to `runtime.resetTurnCache()` with no `resetSceneCache` alias.

Replace progress vocabulary:

```js
'preprocess.deck': 'Building turn deck',
'preprocess.hand': 'Selecting turn hand',
'preprocess.packet': 'Composing prompt packet'
```

Remove `Checking scene shift`, `Reusing scene deck`, and `Saving scene cache` from canonical active-stage copy.

- [ ] **Step 5: Update the visual contracts**

In `DESIGN.md` and `docs/design/UI_SPEC.md`, preserve compact graphite styling while replacing:

- Full Fresh next-send-or-swipe language with next-swipe-only language.
- contextual Reprocess next-generation language with next-swipe language.
- direct scheduler Resume language with native SillyTavern generation ownership.
- generated scene-cache vocabulary and retention controls with turn-cache semantics and automatic prior-turn pruning.
- Reset Scene Cache with Reset Turn Cache.

Do not change dimensions, colors, layout, icon masks, or CSS unless a failing UI layout test demonstrates a need.

- [ ] **Step 6: Run narrow UI tests**

Run: `node tools/scripts/test-progress.mjs`

Expected: PASS.

Run: `node tools/scripts/test-ui-actions.mjs`

Expected: PASS.

Run: `node tools/scripts/test-ui-render.mjs`

Expected: PASS.

Run: `node tools/scripts/test-ui.mjs`

Expected: PASS on desktop/mobile action-slot, accessible copy, and removed-control assertions.

- [ ] **Step 7: Run the full suite and commit**

Run: `npm.cmd test`

Expected: PASS.

Commit:

```bash
git add DESIGN.md docs/design/UI_SPEC.md src/progress.mjs src/ui.mjs src/ui/view-model.mjs tools/scripts/test-progress.mjs tools/scripts/test-ui-actions.mjs tools/scripts/test-ui-render.mjs tools/scripts/test-ui.mjs
git commit -m "feat: expose turn-scoped swipe controls"
```

---

### Task 10: Update Canonical Documentation And Deterministic Proof

**Files:**

- Modify: `README.md`
- Modify: `docs/RECURSION_EXTENSION_SPEC.md`
- Modify: `docs/architecture/CACHE_USE_AND_REUSE_SPEC.md`
- Modify: `docs/architecture/RUNTIME_ARCHITECTURE.md`
- Modify: `docs/architecture/STORAGE_AND_DIAGNOSTICS.md`
- Modify: `docs/technical/STORAGE_AND_DIAGNOSTICS.md`
- Modify: `docs/user/FIRST_RUN_WORKFLOW.md`
- Modify: `docs/user/RECURSION_OPERATOR_MANUAL.md`
- Modify: `docs/DOCUMENTATION_INDEX.md`
- Modify: `tools/scripts/prove-live-resumable-pipeline.mjs`
- Modify: `tools/scripts/prove-live-swipe-reuse.mjs`
- Modify: `tools/scripts/test-live-pipeline-proof.mjs`
- Create: `docs/verification/2026-08-01-turn-scoped-reuse-and-host-owned-resume.md`

**Proof contract:**

The deterministic proof report records hashes and counts, not story text:

```js
{
  newTurn: { arbiterCalls: 1, turnKeyChanged: true },
  unchangedSwipe: { recursionModelCalls: 0, packetReinstalled: true },
  editedBandSwipe: { reuseRejected: true, queuedIntentCanceled: true },
  reprocessSwipe: { selectedStageCalls: 1, intentConsumed: true },
  fullFreshSwipe: { arbiterCalls: 1, requestedCardCalls: 1 },
  stop: { hostStopCalls: 1, promptClears: 1, state: 'paused' },
  resume: { hostStartCalls: 1, detachedProviderCalls: 0 },
  postProcess: { responseIdentityChanged: true, priorRewriteReused: false }
}
```

- [ ] **Step 1: Add failing deterministic proof assertions**

Extend `tools/scripts/test-live-pipeline-proof.mjs` so its fixture requires all eight proof sections above and rejects reports missing `turnKeyChanged`, `recursionModelCalls`, `hostStartCalls`, or `responseIdentityChanged`.

Run: `node tools/scripts/test-live-pipeline-proof.mjs`

Expected: FAIL until the proof script emits the new contract.

- [ ] **Step 2: Update the live proof scripts**

In `prove-live-resumable-pipeline.mjs` and `prove-live-swipe-reuse.mjs`, add deterministic provider counters and host start/stop counters. Exercise this order:

1. normal user turn;
2. unchanged swipe with zero Recursion model calls;
3. queued stage reprocess and matching swipe;
4. Full Fresh and matching swipe;
5. Stop during Planning Card Pass;
6. Resume through native host generation;
7. new user message after completion;
8. new response Post-process identity.

Assert native generation state is active during Resume and the send control is not presented as available detached work.

- [ ] **Step 3: Rewrite canonical docs in place**

Document one coherent V1 contract:

- turn key and bounded source band;
- exact same-turn swipe reuse;
- unconditional fresh generated work for a new user turn;
- no semantic scene lease or TTL;
- next-swipe Reprocess and Full Fresh;
- native Stop/Resume ownership;
- V2 execution/intent storage and display-only Last Brief;
- automatic retired generated-record pruning;
- Reset Turn Cache and removed scene-cache retention controls.

Historical dated specs and plans remain historical evidence; do not rewrite them to look current.

- [ ] **Step 4: Run documentation and repository verification**

Run:

```powershell
rg -n -i "next generation|next send|scene cache|scene-cache|sceneCachesPerChat|sceneCachesTotal|sourceVariantsPerScene|Reset Scene Cache" DESIGN.md README.md docs/RECURSION_EXTENSION_SPEC.md docs/architecture docs/design/UI_SPEC.md docs/technical docs/user src
```

Expected: no current-contract occurrence except explicit statements that legacy generated scene-cache records are retired and deleted.

Run: `node tools/scripts/test-live-pipeline-proof.mjs`

Expected: PASS.

Run: `npm.cmd test`

Expected: PASS.

Run: `npm.cmd test:alpha`

Expected: PASS.

- [ ] **Step 5: Run deterministic SillyTavern proof in the dedicated soak user**

Run:

```powershell
$env:SILLYTAVERN_BASE_URL = 'http://127.0.0.1:8000'
$env:RECURSION_SILLYTAVERN_USER = 'recursion-soak-a'
node tools/scripts/prove-live-resumable-pipeline.mjs --live
```

Expected: PASS with no external model calls and a report containing all eight proof sections.

Run:

```powershell
$env:SILLYTAVERN_BASE_URL = 'http://127.0.0.1:8000'
$env:RECURSION_SILLYTAVERN_USER = 'recursion-soak-a'
node tools/scripts/prove-live-swipe-reuse.mjs --live
```

Expected: PASS for exact same-turn packet reuse and changed-turn rejection. Keep this isolated proof separate from the later `default-user` reproduction path.

- [ ] **Step 6: Commit docs and proof updates**

```bash
git add README.md docs tools/scripts/prove-live-resumable-pipeline.mjs tools/scripts/prove-live-swipe-reuse.mjs tools/scripts/test-live-pipeline-proof.mjs
git commit -m "docs: certify turn-scoped generation lifecycle"
```

- [ ] **Step 7: Synchronize production files to `default-user` only after all repository gates pass**

Copy only:

```text
manifest.json
package.json
src/**
styles/**
assets/icons/**
```

from `F:\git\Recursion\.worktrees\resumable-pipeline-execution` to:

```text
F:\SillyTavern\SillyTavern\data\default-user\extensions\Recursion-refactor
F:\SillyTavern\SillyTavern\public\scripts\extensions\third-party\Recursion-refactor
```

Do not copy `.git`, `node_modules`, tests, docs, artifacts, logs, chats, settings, or user files.

- [ ] **Step 8: Verify installed-copy parity**

Run:

```powershell
node tools/scripts/verify-installed-copy.mjs --repo-root "F:\git\Recursion\.worktrees\resumable-pipeline-execution" --installed-root "F:\SillyTavern\SillyTavern\data\default-user\extensions\Recursion-refactor" --public-root "F:\SillyTavern\SillyTavern\public\scripts\extensions\third-party\Recursion-refactor"
```

Expected: PASS with zero missing, extra, or content-mismatched production files.

- [ ] **Step 9: Run installed `default-user` live proof**

Use the existing signed-in/local SillyTavern browser session and exercise both reported paths:

1. Writer: start Planning Card Pass, click its contextual Stop, confirm native generation stops and the manifest remains paused; click Resume, confirm native SillyTavern generation becomes active and the interceptor resumes the saved frontier.
2. Writer: send the next user message, confirm Planning Card Pass starts again with a different turn key.
3. SG-1: complete one generation, send another user message, confirm a new Arbiter operation begins rather than skipping to story generation.
4. SG-1: swipe the unchanged latest assistant response, confirm the packet is reinstalled with zero Recursion model calls and native story generation proceeds.
5. Queue Reprocess and Full Fresh separately, confirm neither starts work on click and each affects exactly one matching swipe.

Capture the installed extension version/hash, journal lifecycle codes, manifest states, provider call counts, prompt install/clear counts, and screenshots of Stop and Resume ownership. Do not persist raw chat text in the verification report.

- [ ] **Step 10: Write final verification evidence**

Populate `docs/verification/2026-08-01-turn-scoped-reuse-and-host-owned-resume.md` with:

- exact branch and commit SHA;
- narrow/full/alpha test commands and pass counts;
- installed-copy file count and parity result;
- Writer and SG-1 manifest/journal evidence;
- zero-model-call swipe count;
- one-shot Reprocess/Full Fresh evidence;
- native Stop/Resume call counts;
- any remaining warnings or unverified external-provider behavior.

Commit only if the live evidence matches the acceptance criteria:

```bash
git add docs/verification/2026-08-01-turn-scoped-reuse-and-host-owned-resume.md
git commit -m "test: record installed lifecycle proof"
```

---

## Final Acceptance Gate

- [ ] A new user message creates a different turn key before any provider work and runs a new Arbiter.
- [ ] Repeated user text with a new message id is still a new turn.
- [ ] An edit inside the configured source band rejects reuse; an edit outside it does not.
- [ ] An unchanged swipe makes zero Recursion model calls and reinstalls the same validated packet.
- [ ] Corrupt or missing artifacts force recomputation rather than unsafe reuse.
- [ ] Legacy generated scene-cache records cannot be loaded as generation input and are pruned.
- [ ] Last Brief historical data has no generation-facing storage API.
- [ ] Reprocess and Full Fresh start no work on click, bind to the current turn, affect only the next matching swipe, and consume once.
- [ ] A new user turn cancels queued swipe intents.
- [ ] Post-process creates a new response identity for every assistant swipe and reuses no prior response body or rewrite.
- [ ] Contextual Stop and compact-bar Stop use one idempotent native cleanup path.
- [ ] Resume starts native SillyTavern generation and performs no detached provider call.
- [ ] Host-start failure leaves work paused with a bounded warning.
- [ ] Empty assistant placeholders do not hide pending user input.
- [ ] Current UI/docs contain next-swipe and turn-cache vocabulary with no active scene-lease contract.
- [ ] Full repository, alpha, deterministic proof, installed-copy parity, Writer, and SG-1 gates pass.
