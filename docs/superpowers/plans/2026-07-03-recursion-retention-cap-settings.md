# Recursion Retention Cap Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user-exposed retention caps that bound Recursion-owned source-window work, provider snapshots, scene-cache files, source variants, and run journals without deleting SillyTavern chat data.

**Architecture:** Create a shared retention-policy module, route settings through runtime/host/storage, then expose compact Advanced settings. Host snapshots become bounded by message count and character budget; storage cleanup becomes dynamic and protects active scene cache records.

**Tech Stack:** Vanilla ESM modules, Recursion settings store, SillyTavern host adapter, JSON user-file storage adapter, deterministic Node test scripts.

---

## File Structure

- Create: `src/retention-policy.mjs`  
  Owns defaults, min/max ranges, normalized retention settings, and bounded raw source-window selection.
- Create: `tools/scripts/test-retention-policy.mjs`  
  Verifies normalization, clamping, total/per-chat relationship, and backward source-window trimming.
- Modify: `src/settings.mjs`  
  Adds `retention`, removes journal size from `diagnostics`, and normalizes V1 settings in one place.
- Modify: `src/hosts/sillytavern/host.mjs`  
  Reads current retention settings and returns bounded snapshots instead of normalizing the full chat.
- Modify: `src/runtime.mjs`  
  Includes retention in safe settings view, provider-safe snapshots, source freshness, diagnostics, and maintenance calls.
- Modify: `src/storage.mjs`  
  Reads retention dynamically, applies run-journal caps per call, applies source-variant cap, and exposes a maintenance helper around index repair plus scene-cache pruning.
- Modify: `src/ui.mjs`  
  Adds Advanced > Retention numeric controls and moves journal-size UI out of Diagnostics.
- Modify: `tools/scripts/test-settings.mjs`, `tools/scripts/test-host.mjs`, `tools/scripts/test-runtime.mjs`, `tools/scripts/test-storage.mjs`, `tools/scripts/test-ui.mjs`  
  Adds focused coverage for settings, host snapshot bounds, runtime freshness, storage retention, and UI controls.
- Modify: `docs/architecture/STORAGE_AND_DIAGNOSTICS.md`, `docs/technical/STORAGE_AND_DIAGNOSTICS.md`, `docs/design/UI_SPEC.md`, `docs/user/RECURSION_OPERATOR_MANUAL.md`, `docs/technical/RECURSION_TECHNICAL_MANUAL.md`  
  Updates source-window and retention contract.

---

### Task 1: Add Retention Policy Module

**Files:**
- Create: `src/retention-policy.mjs`
- Create: `tools/scripts/test-retention-policy.mjs`

- [ ] **Step 1: Write failing tests for policy normalization**

Create `tools/scripts/test-retention-policy.mjs`:

```js
import {
  DEFAULT_RETENTION_SETTINGS,
  normalizeRetentionSettings,
  selectBoundedSourceWindow
} from '../../src/retention-policy.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

const defaults = normalizeRetentionSettings({});
assertDeepEqual(defaults, DEFAULT_RETENTION_SETTINGS, 'blank retention uses defaults');

const clamped = normalizeRetentionSettings({
  sourceWindowMessages: 9999,
  sourceWindowCharacters: -5,
  providerVisibleMessages: 1,
  sceneCachesPerChat: 9,
  sceneCachesTotal: 4,
  sourceVariantsPerScene: 99,
  runJournalEntries: 9999
});

assertEqual(clamped.sourceWindowMessages, 200, 'sourceWindowMessages clamps high');
assertEqual(clamped.sourceWindowCharacters, 24000, 'invalid sourceWindowCharacters falls back');
assertEqual(clamped.providerVisibleMessages, 4, 'providerVisibleMessages clamps low');
assertEqual(clamped.sceneCachesPerChat, 9, 'sceneCachesPerChat keeps valid value');
assertEqual(clamped.sceneCachesTotal, 9, 'sceneCachesTotal rises to per-chat cap');
assertEqual(clamped.sourceVariantsPerScene, 8, 'sourceVariantsPerScene clamps high');
assertEqual(clamped.runJournalEntries, 500, 'runJournalEntries clamps high');

const rawMessages = Array.from({ length: 8 }, (_, index) => ({
  mesid: index,
  is_user: index % 2 === 1,
  mes: `message-${index}`
}));
rawMessages[2].is_system = true;
rawMessages[6].hidden = true;

const bounded = selectBoundedSourceWindow(rawMessages, {
  sourceWindowMessages: 3,
  sourceWindowCharacters: 1000
});

assertDeepEqual(
  bounded.messages.map((message) => message.mesid),
  [3, 4, 5],
  'bounded window keeps newest visible non-system messages in chronological order'
);
assertEqual(bounded.metadata.sourceWindowMessageCount, 3, 'metadata records retained message count');
assertEqual(bounded.metadata.sourceWindowTruncated, true, 'metadata marks truncated older messages');
assertEqual(bounded.metadata.sourceWindowLimitReason, 'message-cap', 'metadata records message cap reason');

const charBounded = selectBoundedSourceWindow([
  { mesid: 1, mes: 'old text block' },
  { mesid: 2, mes: 'middle text block' },
  { mesid: 3, mes: 'latest text block' }
], {
  sourceWindowMessages: 10,
  sourceWindowCharacters: 20
});

assertDeepEqual(
  charBounded.messages.map((message) => message.mesid),
  [3],
  'character budget keeps latest message when older message would exceed budget'
);
assertEqual(charBounded.metadata.sourceWindowLimitReason, 'character-budget', 'character cap reason recorded');
assert(charBounded.metadata.sourceWindowCharacterCount > 0, 'metadata records retained characters');

console.log('[pass] retention-policy');
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
node tools\scripts\test-retention-policy.mjs
```

Expected: FAIL with module-not-found for `src/retention-policy.mjs`.

- [ ] **Step 3: Create policy module**

Create `src/retention-policy.mjs`:

```js
export const DEFAULT_RETENTION_SETTINGS = Object.freeze({
  sourceWindowMessages: 48,
  sourceWindowCharacters: 24000,
  providerVisibleMessages: 12,
  sceneCachesPerChat: 3,
  sceneCachesTotal: 24,
  sourceVariantsPerScene: 4,
  runJournalEntries: 100
});

export const RETENTION_LIMITS = Object.freeze({
  sourceWindowMessages: { min: 12, max: 200, step: 4 },
  sourceWindowCharacters: { min: 6000, max: 100000, step: 1000 },
  providerVisibleMessages: { min: 4, max: 32, step: 1 },
  sceneCachesPerChat: { min: 1, max: 12, step: 1 },
  sceneCachesTotal: { min: 4, max: 100, step: 4 },
  sourceVariantsPerScene: { min: 1, max: 8, step: 1 },
  runJournalEntries: { min: 10, max: 500, step: 10 }
});

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function integerInRange(value, fallback, limits) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(limits.min, Math.min(limits.max, Math.round(number)));
}

function rawMessageText(message) {
  if (message === undefined || message === null) return '';
  if (typeof message === 'string') return message;
  if (typeof message !== 'object') return '';
  return String(message.mes ?? message.text ?? message.content ?? '');
}

function messageIsVisibleSource(message) {
  if (!message || typeof message !== 'object') return typeof message === 'string';
  return message.visible !== false && message.hidden !== true && message.is_system !== true;
}

function limitReason(hitMessageCap, hitCharacterBudget) {
  if (hitMessageCap && hitCharacterBudget) return 'both';
  if (hitMessageCap) return 'message-cap';
  if (hitCharacterBudget) return 'character-budget';
  return undefined;
}

export function normalizeRetentionSettings(value = {}) {
  const source = objectValue(value);
  const normalized = {
    sourceWindowMessages: integerInRange(
      source.sourceWindowMessages,
      DEFAULT_RETENTION_SETTINGS.sourceWindowMessages,
      RETENTION_LIMITS.sourceWindowMessages
    ),
    sourceWindowCharacters: integerInRange(
      source.sourceWindowCharacters,
      DEFAULT_RETENTION_SETTINGS.sourceWindowCharacters,
      RETENTION_LIMITS.sourceWindowCharacters
    ),
    providerVisibleMessages: integerInRange(
      source.providerVisibleMessages,
      DEFAULT_RETENTION_SETTINGS.providerVisibleMessages,
      RETENTION_LIMITS.providerVisibleMessages
    ),
    sceneCachesPerChat: integerInRange(
      source.sceneCachesPerChat,
      DEFAULT_RETENTION_SETTINGS.sceneCachesPerChat,
      RETENTION_LIMITS.sceneCachesPerChat
    ),
    sceneCachesTotal: integerInRange(
      source.sceneCachesTotal,
      DEFAULT_RETENTION_SETTINGS.sceneCachesTotal,
      RETENTION_LIMITS.sceneCachesTotal
    ),
    sourceVariantsPerScene: integerInRange(
      source.sourceVariantsPerScene,
      DEFAULT_RETENTION_SETTINGS.sourceVariantsPerScene,
      RETENTION_LIMITS.sourceVariantsPerScene
    ),
    runJournalEntries: integerInRange(
      source.runJournalEntries,
      DEFAULT_RETENTION_SETTINGS.runJournalEntries,
      RETENTION_LIMITS.runJournalEntries
    )
  };
  normalized.sceneCachesTotal = Math.max(normalized.sceneCachesTotal, normalized.sceneCachesPerChat);
  return normalized;
}

export function selectBoundedSourceWindow(messages = [], retention = {}) {
  const caps = normalizeRetentionSettings(retention);
  const source = Array.isArray(messages) ? messages : [];
  const kept = [];
  let sourceWindowCharacterCount = 0;
  let hitMessageCap = false;
  let hitCharacterBudget = false;

  for (let index = source.length - 1; index >= 0; index -= 1) {
    const message = source[index];
    if (!messageIsVisibleSource(message)) continue;
    const textLength = rawMessageText(message).length;
    const nextCharacters = sourceWindowCharacterCount + textLength;
    hitMessageCap = kept.length >= caps.sourceWindowMessages;
    hitCharacterBudget = kept.length > 0 && nextCharacters > caps.sourceWindowCharacters;
    if (hitMessageCap || hitCharacterBudget) break;
    kept.push(message);
    sourceWindowCharacterCount = nextCharacters;
  }

  const ordered = kept.reverse();
  const sourceWindowLimitReason = limitReason(hitMessageCap, hitCharacterBudget);
  const first = ordered[0];
  const last = ordered.at(-1);
  const firstMesId = Number(first?.mesid ?? first?.id ?? first?.index ?? 0);
  const lastMesId = Number(last?.mesid ?? last?.id ?? last?.index ?? firstMesId);
  return {
    messages: ordered,
    metadata: {
      sourceWindowFirstMesId: Number.isFinite(firstMesId) ? firstMesId : 0,
      sourceWindowLastMesId: Number.isFinite(lastMesId) ? lastMesId : 0,
      sourceWindowMessageCount: ordered.length,
      sourceWindowCharacterCount,
      sourceWindowTruncated: Boolean(sourceWindowLimitReason),
      ...(sourceWindowLimitReason ? { sourceWindowLimitReason } : {})
    }
  };
}
```

- [ ] **Step 4: Run policy test**

Run:

```powershell
node tools\scripts\test-retention-policy.mjs
```

Expected: PASS with `[pass] retention-policy`.

- [ ] **Step 5: Commit**

```powershell
git add src\retention-policy.mjs tools\scripts\test-retention-policy.mjs
git commit -m "feat: add retention policy caps"
```

---

### Task 2: Wire V1 Settings Shape

**Files:**
- Modify: `src/settings.mjs`
- Modify: `tools/scripts/test-settings.mjs`

- [ ] **Step 1: Write failing settings tests**

Add assertions to `tools/scripts/test-settings.mjs` near the existing diagnostics tests:

```js
const retentionDefaults = normalizeSettings({ retention: {} }).retention;
assertEqual(retentionDefaults.sourceWindowMessages, 48, 'retention source messages default');
assertEqual(retentionDefaults.sourceWindowCharacters, 24000, 'retention character budget default');
assertEqual(retentionDefaults.providerVisibleMessages, 12, 'retention provider messages default');
assertEqual(retentionDefaults.sceneCachesPerChat, 3, 'retention per-chat scene cache default');
assertEqual(retentionDefaults.sceneCachesTotal, 24, 'retention total scene cache default');
assertEqual(retentionDefaults.sourceVariantsPerScene, 4, 'retention source variant default');
assertEqual(retentionDefaults.runJournalEntries, 100, 'retention journal default');

const retentionClamped = normalizeSettings({
  retention: {
    sourceWindowMessages: 999,
    sourceWindowCharacters: 5,
    providerVisibleMessages: 1,
    sceneCachesPerChat: 9,
    sceneCachesTotal: 4,
    sourceVariantsPerScene: 99,
    runJournalEntries: 9999
  }
}).retention;
assertEqual(retentionClamped.sourceWindowMessages, 200, 'settings clamps source message cap');
assertEqual(retentionClamped.sourceWindowCharacters, 6000, 'settings clamps source character cap');
assertEqual(retentionClamped.providerVisibleMessages, 4, 'settings clamps provider message cap');
assertEqual(retentionClamped.sceneCachesTotal, 9, 'settings keeps total at least per-chat cap');
assertEqual(retentionClamped.sourceVariantsPerScene, 8, 'settings clamps source variants');
assertEqual(retentionClamped.runJournalEntries, 500, 'settings clamps journal entries');

store.update({ retention: { sourceWindowMessages: 64, runJournalEntries: 120 } });
assertEqual(root.recursion.retention.sourceWindowMessages, 64, 'partial retention update preserves source cap');
assertEqual(root.recursion.retention.runJournalEntries, 120, 'partial retention update preserves journal cap');
```

Update the old diagnostics test that used `maxJournalEntries` so it now asserts only `includeExcerpts` under diagnostics.

- [ ] **Step 2: Run settings test to verify failure**

Run:

```powershell
node tools\scripts\test-settings.mjs
```

Expected: FAIL because `normalizeSettings(...).retention` is undefined.

- [ ] **Step 3: Update settings defaults and normalizer**

Modify `src/settings.mjs`:

```js
import { cloneJson } from './core.mjs';
import { defaultCardScope, normalizeCardScope } from './card-scope.mjs';
import { DEFAULT_RETENTION_SETTINGS, normalizeRetentionSettings } from './retention-policy.mjs';
```

Add retention to `DEFAULT_RECURSION_SETTINGS`:

```js
  diagnostics: {
    includeExcerpts: false
  },
  retention: DEFAULT_RETENTION_SETTINGS,
```

Update `normalizeSettings(value, secretStore)` so the returned object includes:

```js
    diagnostics: {
      includeExcerpts: source.diagnostics?.includeExcerpts === true
    },
    retention: normalizeRetentionSettings(source.retention),
```

Keep the existing provider, injection, card-scope, and UI normalization unchanged.

- [ ] **Step 4: Run settings test**

Run:

```powershell
node tools\scripts\test-settings.mjs
```

Expected: PASS with `[pass] settings`.

- [ ] **Step 5: Commit**

```powershell
git add src\settings.mjs tools\scripts\test-settings.mjs
git commit -m "feat: add retention settings"
```

---

### Task 3: Bound SillyTavern Host Snapshots

**Files:**
- Modify: `src/hosts/sillytavern/host.mjs`
- Modify: `tools/scripts/test-host.mjs`

- [ ] **Step 1: Write failing host snapshot test**

Add a test in `tools/scripts/test-host.mjs` that creates a host with settings root:

```js
{
  const context = {
    chatId: 'long-chat',
    chat: Array.from({ length: 30 }, (_, index) => ({
      mesid: index,
      is_user: index % 2 === 1,
      mes: `visible message ${index}`
    })),
    extensionSettings: {
      recursion: {
        retention: {
          sourceWindowMessages: 5,
          sourceWindowCharacters: 1000,
          providerVisibleMessages: 4
        }
      }
    }
  };
  const host = createSillyTavernHost({
    contextFactory: () => context,
    fetchImpl: null
  });
  const snapshot = await host.snapshot();
  assertEqual(snapshot.messages.length, 5, 'host snapshot keeps bounded source messages');
  assertDeepEqual(
    snapshot.messages.map((message) => message.mesid),
    [25, 26, 27, 28, 29],
    'host snapshot keeps newest bounded source window'
  );
  assertEqual(snapshot.sourceWindowMessageCount, 5, 'snapshot exposes source window count');
  assertEqual(snapshot.sourceWindowTruncated, true, 'snapshot marks bounded source window');
  assertEqual(snapshot.sourceWindowLimitReason, 'message-cap', 'snapshot records message cap reason');
}
```

- [ ] **Step 2: Run host test to verify failure**

Run:

```powershell
node tools\scripts\test-host.mjs
```

Expected: FAIL because host snapshot still returns all messages.

- [ ] **Step 3: Update host snapshot logic**

Modify `src/hosts/sillytavern/host.mjs` imports:

```js
import { normalizeRetentionSettings, selectBoundedSourceWindow } from '../../retention-policy.mjs';
```

Add helper near `latestMessageId(messages)`:

```js
function latestMessageIdFromRawChat(messages) {
  const source = Array.isArray(messages) ? messages : [];
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const numeric = numericMessageId(source[index], index);
    if (Number.isFinite(numeric)) return numeric;
  }
  return -1;
}
```

Replace the body of `snapshot()` with this bounded flow:

```js
  async function snapshot() {
    const context = currentContext(contextFactory);
    const chatId = await readChatId(context);
    const chatKey = safeId(chatId, 'chat');
    const retention = normalizeRetentionSettings(settingsStore.get().retention);
    const rawChat = Array.isArray(context.chat) ? context.chat : [];
    const bounded = selectBoundedSourceWindow(rawChat, retention);
    const messages = bounded.messages.map((message, index) => normalizeMessage(message, index));
    const latestMesId = latestMessageIdFromRawChat(rawChat);
    const sourceRevisionHash = hashJson(sourceRevisionMessages(messages));
    const sceneFingerprint = hashJson({
      chatKey,
      sceneAnchor: sceneAnchor(context)
    });
    const turnFingerprint = hashJson({
      chatKey,
      latestMesId,
      sourceRevisionHash,
      latestMessage: messages.at(-1) || null
    });
    const sceneKey = safeId(`${chatKey}-${sceneFingerprint}`, 'scene');

    return {
      hostId: 'sillytavern',
      chatId,
      chatKey,
      sceneFingerprint,
      sceneKey,
      sourceRevisionHash,
      turnFingerprint,
      latestMesId,
      messages,
      ...bounded.metadata
    };
  }
```

- [ ] **Step 4: Run host test**

Run:

```powershell
node tools\scripts\test-host.mjs
```

Expected: PASS with `[pass] host`.

- [ ] **Step 5: Commit**

```powershell
git add src\hosts\sillytavern\host.mjs tools\scripts\test-host.mjs
git commit -m "feat: bound host source snapshots"
```

---

### Task 4: Apply Retention in Runtime Provider and Freshness Paths

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-runtime.mjs`

- [ ] **Step 1: Write failing provider cap test**

Add a runtime test with retention settings:

```js
{
  let observedSnapshot = null;
  const messages = Array.from({ length: 12 }, (_, index) => ({
    mesid: index,
    role: index % 2 === 0 ? 'assistant' : 'user',
    text: `message ${index}`,
    visible: true
  }));
  const { runtime } = createRuntimeHarness({
    snapshot: {
      chatId: 'provider-cap-chat',
      chatKey: 'provider-cap-chat',
      sceneKey: 'provider-cap-scene',
      sceneFingerprint: 'provider-cap-scene',
      latestMesId: 11,
      messages
    },
    settings: {
      retention: {
        providerVisibleMessages: 5
      }
    },
    generationRouter: {
      async generate(roleId, request) {
        if (roleId === 'utilityArbiter') observedSnapshot = request.snapshot;
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'compose-brief',
            cardJobs: [],
            budgets: { targetBriefTokens: 500, maxCards: 6 },
            reasonerDecision: { mode: 'skip', reason: 'provider cap test' },
            diagnostics: ['provider-cap-test']
          }
        };
      }
    }
  });

  await runtime.prepareForGeneration({ userMessage: 'Use provider cap.' });
  assertEqual(observedSnapshot.messages.length, 5, 'provider snapshot honors retention provider cap');
  assertDeepEqual(
    observedSnapshot.messages.map((message) => message.mesid),
    [7, 8, 9, 10, 11],
    'provider snapshot keeps newest provider-visible messages'
  );
}
```

- [ ] **Step 2: Write failing stale source-window test**

Add a test that creates a cached card whose evidence range falls before the bounded snapshot:

```js
{
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  await storage.saveSceneCache('bounded-window-chat', 'bounded-window-scene', {
    cards: [{
      id: 'old-evidence-card',
      family: 'Scene Frame',
      summary: 'old evidence',
      promptText: 'Old evidence should not compose.',
      evidenceRefs: ['message:1'],
      source: {
        chatId: 'bounded-window-chat',
        firstMesId: 1,
        lastMesId: 1,
        fingerprint: 'old-source',
        snapshotHash: 'old-source',
        sourceRevisionHash: 'old-source'
      },
      freshness: { sourceFingerprint: 'old-source' }
    }]
  });

  const messages = Array.from({ length: 10 }, (_, index) => ({
    mesid: index,
    role: index % 2 === 0 ? 'assistant' : 'user',
    text: `message ${index}`,
    visible: true
  })).slice(-4);

  const { runtime } = createRuntimeHarness({
    storage,
    snapshot: {
      chatId: 'bounded-window-chat',
      chatKey: 'bounded-window-chat',
      sceneKey: 'bounded-window-scene',
      sceneFingerprint: 'bounded-window-scene',
      latestMesId: 9,
      messages,
      sourceWindowTruncated: true
    }
  });

  await runtime.prepareForGeneration({ userMessage: 'Reject stale old cache.' });
  const serializedPacket = JSON.stringify(runtime.view().lastPacket || {});
  assert(!serializedPacket.includes('Old evidence should not compose.'), 'old out-of-window cache promptText is not composed');
}
```

- [ ] **Step 3: Run runtime test to verify failure**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: FAIL because provider snapshot still uses the hard-coded 12 message cap or runtime helpers do not pass retention to provider-safe snapshots.

- [ ] **Step 4: Update runtime safe settings and provider snapshots**

Modify `src/runtime.mjs` imports:

```js
import { normalizeRetentionSettings } from './retention-policy.mjs';
```

Change the provider snapshot helper signature:

```js
function providerSafeSnapshot(snapshot = {}, retention = {}) {
  const source = asObject(snapshot);
  const caps = normalizeRetentionSettings(retention);
  const messages = Array.isArray(source.messages)
    ? source.messages.map(providerSafeMessage).filter(Boolean).slice(-caps.providerVisibleMessages)
    : [];
  return {
    sceneKey: safeText(source.sceneKey || DEFAULT_SCENE_KEY, 120) || DEFAULT_SCENE_KEY,
    sceneFingerprint: safeText(source.sceneFingerprint || '', 180),
    turnFingerprint: safeText(source.turnFingerprint || '', 180),
    sourceRevisionHash: safeText(source.sourceRevisionHash || '', 180),
    latestMesId: numberOr(source.latestMesId, 0),
    messages
  };
}
```

Update `safeSettingsView(settings)` to include:

```js
    retention: normalizeRetentionSettings(source.retention),
```

Update calls that build provider requests:

```js
          `Snapshot: ${JSON.stringify(providerSafeSnapshot(snapshot, settings.retention))}`
```

and:

```js
      snapshot: providerSafeSnapshot(snapshot, settings.retention),
```

Add source-window metadata to diagnostics export near the existing snapshot metadata:

```js
        sourceWindow: {
          messageCount: numberOr(lastSnapshot.sourceWindowMessageCount, 0),
          characterCount: numberOr(lastSnapshot.sourceWindowCharacterCount, 0),
          truncated: lastSnapshot.sourceWindowTruncated === true,
          limitReason: safeText(lastSnapshot.sourceWindowLimitReason || '', 80)
        },
```

- [ ] **Step 5: Run runtime test**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: PASS with `[pass] runtime`.

- [ ] **Step 6: Commit**

```powershell
git add src\runtime.mjs tools\scripts\test-runtime.mjs
git commit -m "feat: apply retention to runtime snapshots"
```

---

### Task 5: Make Storage Retention Dynamic

**Files:**
- Modify: `src/storage.mjs`
- Modify: `src/extension/index.js`
- Modify: `tools/scripts/test-storage.mjs`
- Modify: `tools/scripts/test-runtime.mjs`

- [ ] **Step 1: Write failing dynamic journal test**

Add to `tools/scripts/test-storage.mjs`:

```js
{
  const adapter = createMemoryStorageAdapter();
  let retention = { runJournalEntries: 2 };
  const repo = createStorageRepository({
    storage: adapter,
    getRetentionSettings: () => retention
  });
  await repo.appendJournal('Dynamic Journal Chat', { event: 'runtime.started', summary: 'one' });
  await repo.appendJournal('Dynamic Journal Chat', { event: 'activity.settled', summary: 'two' });
  await repo.appendJournal('Dynamic Journal Chat', { event: 'activity.settled', summary: 'three' });
  let journal = await repo.loadRunJournal('Dynamic Journal Chat');
  assertDeepEqual(journal.entries.map((entry) => entry.summary), ['two', 'three'], 'dynamic retention starts at two entries');

  retention = { runJournalEntries: 3 };
  await repo.appendJournal('Dynamic Journal Chat', { event: 'activity.settled', summary: 'four' });
  journal = await repo.loadRunJournal('Dynamic Journal Chat');
  assertDeepEqual(journal.entries.map((entry) => entry.summary), ['two', 'three', 'four'], 'dynamic retention expands on next append');
}
```

- [ ] **Step 2: Write failing source variant cap test**

Add to `tools/scripts/test-storage.mjs`:

```js
{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({
    storage: adapter,
    getRetentionSettings: () => ({ sourceVariantsPerScene: 2 })
  });
  await repo.saveSceneCache('Variant Cap Chat', 'Scene One', {
    activeSourceRevisionHash: 'rev-c',
    variantOrder: ['rev-a', 'rev-b', 'rev-c'],
    variants: {
      'rev-a': { sourceRevisionHash: 'rev-a', cards: [] },
      'rev-b': { sourceRevisionHash: 'rev-b', cards: [] },
      'rev-c': { sourceRevisionHash: 'rev-c', cards: [] }
    }
  });
  const cache = await repo.loadSceneCache('Variant Cap Chat', 'Scene One');
  assertDeepEqual(cache.variantOrder, ['rev-b', 'rev-c'], 'storage applies dynamic variant cap');
  assert(!cache.variants['rev-a'], 'storage drops oldest variant beyond cap');
}
```

- [ ] **Step 3: Write failing maintenance test**

Add to `tools/scripts/test-storage.mjs`:

```js
{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({
    storage: adapter,
    getRetentionSettings: () => ({ sceneCachesPerChat: 1, sceneCachesTotal: 2 })
  });
  await repo.saveSceneCache('Maintain Chat A', 'Old Scene', {});
  await repo.saveSceneCache('Maintain Chat A', 'Active Scene', {});
  await repo.saveSceneCache('Maintain Chat B', 'Other Scene', {});
  const result = await repo.maintainRetention({
    activeScene: { chatKey: 'Maintain Chat A', sceneKey: 'Active Scene' }
  });
  const dump = adapter.dump();
  assertEqual(result.ok, true, 'maintainRetention succeeds');
  assert(!dump[sceneCacheKey('Maintain Chat A', 'Old Scene')], 'maintenance prunes old same-chat scene');
  assert(dump[sceneCacheKey('Maintain Chat A', 'Active Scene')], 'maintenance protects active scene');
  assert(dump[sceneCacheKey('Maintain Chat B', 'Other Scene')], 'maintenance keeps total cap survivor');
}
```

- [ ] **Step 4: Run storage test to verify failure**

Run:

```powershell
node tools\scripts\test-storage.mjs
```

Expected: FAIL because `getRetentionSettings` and `maintainRetention` do not exist.

- [ ] **Step 5: Update storage repository**

Modify `src/storage.mjs` import:

```js
import { normalizeRetentionSettings } from './retention-policy.mjs';
```

Change repository factory signature:

```js
export function createStorageRepository({
  storage = createMemoryStorageAdapter(),
  maxJournalEntries = 100,
  activity = null,
  getRetentionSettings = null
} = {}) {
  function currentRetention() {
    return normalizeRetentionSettings(
      typeof getRetentionSettings === 'function'
        ? getRetentionSettings()
        : { runJournalEntries: maxJournalEntries }
    );
  }
```

Update `loadRunJournal`:

```js
  async function loadRunJournal(chatKey) {
    const key = runJournalKey(chatKey);
    return normalizeJournal(chatKey, await storage.readJson(key), currentRetention().runJournalEntries);
  }
```

Pass `currentRetention().sourceVariantsPerScene` into scene-cache normalization. Replace hard-coded `MAX_SCENE_CACHE_VARIANTS` slicing with a normalized `variantLimit` parameter:

```js
function normalizeSceneCacheVariants(source, variantLimit = MAX_SCENE_CACHE_VARIANTS) {
  const limit = Math.max(1, Math.min(MAX_SCENE_CACHE_VARIANTS, Number(variantLimit) || MAX_SCENE_CACHE_VARIANTS));
  const boundedOrder = [...requestedOrder, ...discoveredOrder]
    .filter((key, index, list) => key && normalized[key] && list.indexOf(key) === index)
    .slice(-limit);
```

Update `saveSceneCache` and `loadSceneCache` to call `normalizeSceneCache(chatKey, sceneKey, value, currentRetention())`.

Add `maintainRetention` to returned repository:

```js
    async maintainRetention(options = {}) {
      const retention = currentRetention();
      return pruneSceneCaches({
        ...options,
        maxPerChat: retention.sceneCachesPerChat,
        maxTotal: retention.sceneCachesTotal
      });
    },
```

- [ ] **Step 6: Pass retention into bootstrap storage**

Modify `src/extension/index.js` repository creation:

```js
    const storage = createStorageRepository({
      storage: nextHost.storageAdapter,
      activity,
      getRetentionSettings: () => nextHost.settingsStore.get().retention
    });
```

- [ ] **Step 7: Add runtime maintenance call**

In `src/runtime.mjs`, after successful scene-cache saves, call maintenance best-effort:

```js
  async function maintainRetentionSafe(runId, snapshot) {
    if (typeof storage.maintainRetention !== 'function') return null;
    try {
      return await storage.maintainRetention({
        activeScene: { chatKey: snapshot.chatKey, sceneKey: snapshot.sceneKey }
      });
    } catch (error) {
      reportStorageWarning(runId, 'maintainRetention', error);
      return null;
    }
  }
```

Call it at the end of `saveSceneCacheSafe` only when `result?.storageStatus?.persisted !== false`:

```js
      if (result?.storageStatus?.persisted !== false) {
        await maintainRetentionSafe(runId, snapshot);
      }
```

- [ ] **Step 8: Run storage and runtime tests**

Run:

```powershell
node tools\scripts\test-storage.mjs
node tools\scripts\test-runtime.mjs
```

Expected: both PASS.

- [ ] **Step 9: Commit**

```powershell
git add src\storage.mjs src\extension\index.js src\runtime.mjs tools\scripts\test-storage.mjs tools\scripts\test-runtime.mjs
git commit -m "feat: enforce dynamic storage retention"
```

---

### Task 6: Add Advanced Retention Controls

**Files:**
- Modify: `src/ui.mjs`
- Modify: `tools/scripts/test-ui.mjs`

- [ ] **Step 1: Write failing UI test**

Add assertions near existing Advanced settings tests in `tools/scripts/test-ui.mjs`:

```js
assert(root.querySelector('[data-recursion-settings-section-retention]'), 'Advanced settings groups retention controls');
assert(root.querySelector('[data-recursion-setting-source-window-messages]'), 'Retention renders source message cap');
assert(root.querySelector('[data-recursion-setting-source-window-characters]'), 'Retention renders source character budget');
assert(root.querySelector('[data-recursion-setting-provider-visible-messages]'), 'Retention renders provider message cap');
assert(root.querySelector('[data-recursion-setting-scene-caches-per-chat]'), 'Retention renders per-chat scene cache cap');
assert(root.querySelector('[data-recursion-setting-scene-caches-total]'), 'Retention renders total scene cache cap');
assert(root.querySelector('[data-recursion-setting-source-variants-per-scene]'), 'Retention renders source variant cap');
assert(root.querySelector('[data-recursion-setting-run-journal-entries]'), 'Retention renders journal entry cap');
assertEqual(
  root.querySelector('[data-recursion-setting-source-window-messages]').getAttribute('min'),
  '12',
  'source message cap min exposed'
);
assertEqual(
  root.querySelector('[data-recursion-setting-run-journal-entries]').getAttribute('max'),
  '500',
  'journal entry cap max exposed'
);
```

Extend the autosave test:

```js
root.querySelector('[data-recursion-setting-source-window-messages]').value = '64';
root.querySelector('[data-recursion-setting-run-journal-entries]').value = '120';
root.querySelector('[data-recursion-settings-panel]').dispatchEvent({ type: 'change', target: root.querySelector('[data-recursion-setting-source-window-messages]') });
root.querySelector('[data-recursion-settings-panel]').dispatchEvent({ type: 'change', target: root.querySelector('[data-recursion-setting-run-journal-entries]') });
assertEqual(settingsUpdates.at(-1).retention.runJournalEntries, 120, 'retention journal cap autosaves');
```

- [ ] **Step 2: Run UI test to verify failure**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: FAIL because Retention controls do not exist.

- [ ] **Step 3: Add retention tooltips and controls**

Modify `src/ui.mjs` imports:

```js
import { DEFAULT_RETENTION_SETTINGS, RETENTION_LIMITS } from './retention-policy.mjs';
```

Add tooltip keys:

```js
  retention: 'Operational caps for Recursion-owned source windows and cache files. These never delete SillyTavern chat messages.',
  sourceWindowMessages: 'Recent visible messages Recursion reads for source freshness. Does not delete SillyTavern chat.',
  sourceWindowCharacters: 'Character budget for the source freshness window. Lower values make long chats cheaper; higher values keep more local scene evidence.',
  providerVisibleMessages: 'Recent visible messages sent to Recursion provider calls. This affects Recursion analysis prompts, not the final story model context.',
  sceneCachesPerChat: 'Recursion scene-cache files retained per chat. Old unprotected caches are disposable and can be rebuilt.',
  sceneCachesTotal: 'Total Recursion scene-cache files retained across chats. Cleanup never deletes SillyTavern messages or other extension data.',
  sourceVariantsPerScene: 'Active-source variants retained for swipe A/B/A reuse. Higher values preserve more swipe branches but make scene-cache files larger.',
  runJournalEntries: 'Sanitized Recursion activity entries retained per chat. Higher values help debugging but cost more local storage.',
```

In `renderAdvancedSettings`, create `retention`:

```js
  const retention = asObject(settings.retention);
  const defaultRetention = DEFAULT_RETENTION_SETTINGS;
```

Add helper inside `renderAdvancedSettings`:

```js
  const retentionNumberControl = (key, datasetKey, ariaLabel) => inputControl({
    value: integerInRange(retention[key], defaultRetention[key], RETENTION_LIMITS[key].min, RETENTION_LIMITS[key].max),
    type: 'number',
    min: RETENTION_LIMITS[key].min,
    max: RETENTION_LIMITS[key].max,
    step: RETENTION_LIMITS[key].step,
    dataset: { [datasetKey]: '' },
    ariaLabel
  });
```

Add controls:

```js
  const sourceMessagesControl = retentionNumberControl('sourceWindowMessages', 'recursionSettingSourceWindowMessages', 'Source freshness message cap');
  setTooltip(sourceMessagesControl, tooltipsEnabled, SETTINGS_TOOLTIPS.sourceWindowMessages);
  const sourceCharactersControl = retentionNumberControl('sourceWindowCharacters', 'recursionSettingSourceWindowCharacters', 'Source freshness character budget');
  setTooltip(sourceCharactersControl, tooltipsEnabled, SETTINGS_TOOLTIPS.sourceWindowCharacters);
  const providerMessagesControl = retentionNumberControl('providerVisibleMessages', 'recursionSettingProviderVisibleMessages', 'Provider visible message cap');
  setTooltip(providerMessagesControl, tooltipsEnabled, SETTINGS_TOOLTIPS.providerVisibleMessages);
  const perChatCacheControl = retentionNumberControl('sceneCachesPerChat', 'recursionSettingSceneCachesPerChat', 'Scene caches retained per chat');
  setTooltip(perChatCacheControl, tooltipsEnabled, SETTINGS_TOOLTIPS.sceneCachesPerChat);
  const totalCacheControl = retentionNumberControl('sceneCachesTotal', 'recursionSettingSceneCachesTotal', 'Total scene caches retained');
  setTooltip(totalCacheControl, tooltipsEnabled, SETTINGS_TOOLTIPS.sceneCachesTotal);
  const variantControl = retentionNumberControl('sourceVariantsPerScene', 'recursionSettingSourceVariantsPerScene', 'Swipe variants retained per scene');
  setTooltip(variantControl, tooltipsEnabled, SETTINGS_TOOLTIPS.sourceVariantsPerScene);
  const journalEntriesControl = retentionNumberControl('runJournalEntries', 'recursionSettingRunJournalEntries', 'Maximum diagnostic journal entries');
  setTooltip(journalEntriesControl, tooltipsEnabled, SETTINGS_TOOLTIPS.runJournalEntries);
```

Append Retention disclosure before Diagnostics:

```js
  group.appendChild(settingsDisclosureSection('retention', 'Retention', [
    controlRow('Source Messages', sourceMessagesControl),
    controlRow('Source Text Budget', sourceCharactersControl),
    controlRow('Provider Messages', providerMessagesControl),
    controlRow('Scene Caches / Chat', perChatCacheControl),
    controlRow('Scene Caches Total', totalCacheControl),
    controlRow('Swipe Variants / Scene', variantControl),
    controlRow('Journal Entries', journalEntriesControl)
  ], { tooltip: SETTINGS_TOOLTIPS.retention, tooltipsEnabled }));
```

Remove `Journal Entries` from Diagnostics and leave Include Excerpts plus actions there.

- [ ] **Step 4: Update settings collection**

In the settings autosave collector in `src/ui.mjs`, replace diagnostics journal collection with:

```js
      retention: {
        sourceWindowMessages: integerInRange(
          controlValue(sourceRoot, '[data-recursion-setting-source-window-messages]'),
          DEFAULT_RETENTION_SETTINGS.sourceWindowMessages,
          RETENTION_LIMITS.sourceWindowMessages.min,
          RETENTION_LIMITS.sourceWindowMessages.max
        ),
        sourceWindowCharacters: integerInRange(
          controlValue(sourceRoot, '[data-recursion-setting-source-window-characters]'),
          DEFAULT_RETENTION_SETTINGS.sourceWindowCharacters,
          RETENTION_LIMITS.sourceWindowCharacters.min,
          RETENTION_LIMITS.sourceWindowCharacters.max
        ),
        providerVisibleMessages: integerInRange(
          controlValue(sourceRoot, '[data-recursion-setting-provider-visible-messages]'),
          DEFAULT_RETENTION_SETTINGS.providerVisibleMessages,
          RETENTION_LIMITS.providerVisibleMessages.min,
          RETENTION_LIMITS.providerVisibleMessages.max
        ),
        sceneCachesPerChat: integerInRange(
          controlValue(sourceRoot, '[data-recursion-setting-scene-caches-per-chat]'),
          DEFAULT_RETENTION_SETTINGS.sceneCachesPerChat,
          RETENTION_LIMITS.sceneCachesPerChat.min,
          RETENTION_LIMITS.sceneCachesPerChat.max
        ),
        sceneCachesTotal: integerInRange(
          controlValue(sourceRoot, '[data-recursion-setting-scene-caches-total]'),
          DEFAULT_RETENTION_SETTINGS.sceneCachesTotal,
          RETENTION_LIMITS.sceneCachesTotal.min,
          RETENTION_LIMITS.sceneCachesTotal.max
        ),
        sourceVariantsPerScene: integerInRange(
          controlValue(sourceRoot, '[data-recursion-setting-source-variants-per-scene]'),
          DEFAULT_RETENTION_SETTINGS.sourceVariantsPerScene,
          RETENTION_LIMITS.sourceVariantsPerScene.min,
          RETENTION_LIMITS.sourceVariantsPerScene.max
        ),
        runJournalEntries: integerInRange(
          controlValue(sourceRoot, '[data-recursion-setting-run-journal-entries]'),
          DEFAULT_RETENTION_SETTINGS.runJournalEntries,
          RETENTION_LIMITS.runJournalEntries.min,
          RETENTION_LIMITS.runJournalEntries.max
        )
      },
```

Keep diagnostics collection as:

```js
      diagnostics: {
        includeExcerpts: controlChecked(sourceRoot, '[data-recursion-setting-include-excerpts]')
      },
```

- [ ] **Step 5: Run UI test**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: PASS with `[pass] ui`.

- [ ] **Step 6: Commit**

```powershell
git add src\ui.mjs tools\scripts\test-ui.mjs
git commit -m "feat: expose retention cap settings"
```

---

### Task 7: Update Docs and Run Gates

**Files:**
- Modify: `docs/architecture/STORAGE_AND_DIAGNOSTICS.md`
- Modify: `docs/technical/STORAGE_AND_DIAGNOSTICS.md`
- Modify: `docs/design/UI_SPEC.md`
- Modify: `docs/user/RECURSION_OPERATOR_MANUAL.md`
- Modify: `docs/technical/RECURSION_TECHNICAL_MANUAL.md`
- Test: all focused scripts touched above

- [ ] **Step 1: Update architecture storage spec**

In `docs/architecture/STORAGE_AND_DIAGNOSTICS.md`, update Settings vs Files and Cleanup sections with this contract:

```markdown
`extension_settings.recursion.retention` stores user-facing caps for Recursion-owned source-window and storage behavior:

- Source Messages: recent visible messages used for source freshness.
- Source Text Budget: character budget for the source freshness window.
- Provider Messages: recent visible messages sent to Recursion provider calls.
- Scene Caches / Chat: unprotected scene-cache files retained per chat.
- Scene Caches Total: unprotected scene-cache files retained across chats.
- Swipe Variants / Scene: source variants retained inside one scene cache.
- Journal Entries: sanitized run-journal entries retained per chat.

These caps never delete, hide, summarize, or rewrite SillyTavern chat messages. They only bound Recursion-owned windows, caches, and diagnostics.
```

- [ ] **Step 2: Update technical storage manual**

In `docs/technical/STORAGE_AND_DIAGNOSTICS.md`, add the same setting list under Settings Vs Logical Records and clarify:

```markdown
Long-chat scaling is handled by the bounded source window. Recursion walks backward from the latest visible chat message until Source Messages or Source Text Budget is reached, then uses that bounded window for source hashes and cache freshness. Older chat messages remain in SillyTavern and can still be used by SillyTavern presets or other extensions.
```

- [ ] **Step 3: Update UI spec**

In `docs/design/UI_SPEC.md`, replace the Advanced Diagnostics line with:

```markdown
- Retention: Source Messages, Source Text Budget, Provider Messages, Scene Caches / Chat, Scene Caches Total, Swipe Variants / Scene, and Journal Entries. These controls tune Recursion-owned windows and cache files; they do not delete SillyTavern chat.
- Diagnostics: safe excerpts, Reset Scene Cache, Export Diagnostics, and Clear Run Journal.
```

- [ ] **Step 4: Update manuals**

In `docs/user/RECURSION_OPERATOR_MANUAL.md` and `docs/technical/RECURSION_TECHNICAL_MANUAL.md`, add a short Retention section:

```markdown
Retention caps are local Recursion tuning controls. Lower Source Messages or Source Text Budget if a very long chat makes Recursion feel slow. Raise Scene Caches or Journal Entries when debugging. These caps only affect Recursion-owned files and analysis windows; they do not prune SillyTavern chat history.
```

- [ ] **Step 5: Run focused tests**

Run:

```powershell
node tools\scripts\test-retention-policy.mjs
node tools\scripts\test-settings.mjs
node tools\scripts\test-host.mjs
node tools\scripts\test-storage.mjs
node tools\scripts\test-runtime.mjs
node tools\scripts\test-ui.mjs
```

Expected: all PASS.

- [ ] **Step 6: Run full deterministic gate**

Run:

```powershell
npm.cmd test
node tools\scripts\run-alpha-gate.mjs
git diff --check
```

Expected: all PASS and `git diff --check` has no output.

- [ ] **Step 7: Commit docs and final verification**

```powershell
git add docs\architecture\STORAGE_AND_DIAGNOSTICS.md docs\technical\STORAGE_AND_DIAGNOSTICS.md docs\design\UI_SPEC.md docs\user\RECURSION_OPERATOR_MANUAL.md docs\technical\RECURSION_TECHNICAL_MANUAL.md
git commit -m "docs: document retention caps"
```

---

## Self-Review

Spec coverage:

- User-exposed cap settings: Task 2 and Task 6.
- Long-chat source-window scale: Task 1, Task 3, Task 4.
- Provider snapshot cap: Task 4 and Task 6.
- Scene cache and source variant retention: Task 5 and Task 6.
- Run journal dynamic cap: Task 2 and Task 5.
- No SillyTavern chat deletion: Task 7 docs and Task 5 storage tests.
- Design docs and manuals: Task 7.

Placeholder scan:

- Plan uses concrete file paths, settings names, snippets, commands, and expected results.
- No task depends on future user input.

Type consistency:

- Settings field is `retention`.
- Journal cap is `runJournalEntries`.
- Provider cap is `providerVisibleMessages`.
- Source freshness caps are `sourceWindowMessages` and `sourceWindowCharacters`.
- Storage cache caps are `sceneCachesPerChat`, `sceneCachesTotal`, and `sourceVariantsPerScene`.
