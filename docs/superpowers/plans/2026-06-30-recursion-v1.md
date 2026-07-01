# Recursion V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Recursion V1 as a mostly automatic SillyTavern extension that observes the current chat, creates scene-local cards with Utility calls, optionally uses a Reasoner composer, installs a compact prompt packet, and shows all invisible work through a native-looking Recursion top bar and Activity Ribbon.

**Architecture:** Implement Recursion as a host-adapter-based extension. Core runtime modules stay host-neutral; SillyTavern-specific code lives under `src/hosts/sillytavern/`. Utility is the default provider lane, Reasoner is optional, storage is cache-oriented, and UI surfaces are observational rather than card-editing tools.

**Tech Stack:** JavaScript ES modules, SillyTavern third-party extension manifest, DOM APIs, `fetch`, Node-based smoke/unit scripts, no build step.

---

## Scope Check

This plan covers all Recursion V1 subsystems because they form one end-to-end runtime loop: settings, host adapter, provider lanes, storage, card deck, prompt composition, UI, and smoke tests. Each task produces a working checkpoint and can be implemented independently, but the final V1 proof is the whole loop from SillyTavern generation start to prompt packet install.

## File Structure

- `manifest.json` - SillyTavern extension manifest.
- `package.json` - local Node scripts for deterministic verification.
- `src/core.mjs` - shared clone, hash, JSON, redaction, string, and id helpers.
- `src/settings.mjs` - extension settings normalization and session-only API key storage.
- `src/storage.mjs` - logical keys, repository, scene cache, run journal, and memory/file adapters.
- `src/activity.mjs` - Activity Reporter state and sanitized activity events.
- `src/providers.mjs` - provider lanes, generation router, structured output parsing, retries, and fallbacks.
- `src/cards.mjs` - V1 card catalog, card validation, deck updates, and hand selection.
- `src/prompt.mjs` - Utility composition, Reasoner composition fallback, packet validation, and prompt blocks.
- `src/runtime.mjs` - Recursion runtime coordinator and V1 turn pipeline.
- `src/hosts/sillytavern/host.mjs` - SillyTavern context, storage, generation, prompt, and event adapter.
- `src/ui.mjs` - Recursion Bar, Activity Ribbon, dropdowns, viewer, and settings/providers UI.
- `src/extension/index.js` - SillyTavern entrypoint, generation interceptor, and lifecycle exports.
- `styles/recursion.css` - SillyTavern-native graphite styling.
- `tools/scripts/run-tests.mjs` - runs all local test scripts.
- `tools/scripts/test-*.mjs` - focused verification scripts.
- `docs/user/RECURSION_OPERATOR_MANUAL.md` - operator manual.

---

### Task 1: Tooling, Manifest, And Test Harness

**Files:**
- Create: `F:\git\Recursion\package.json`
- Create: `F:\git\Recursion\manifest.json`
- Create: `F:\git\Recursion\tools\scripts\run-tests.mjs`
- Create: `F:\git\Recursion\tests\helpers\assert.mjs`
- Create: `F:\git\Recursion\tools\scripts\test-harness.mjs`

- [ ] **Step 1: Write the local package and SillyTavern manifest**

Replace `F:\git\Recursion\package.json` with:

```json
{
  "name": "recursion",
  "version": "0.1.0-pre-alpha.1",
  "private": true,
  "description": "Recursion pre-alpha SillyTavern extension.",
  "type": "module",
  "license": "MIT",
  "scripts": {
    "test": "node tools/scripts/run-tests.mjs",
    "test:harness": "node tools/scripts/test-harness.mjs",
    "test:core": "node tools/scripts/test-core.mjs",
    "test:settings": "node tools/scripts/test-settings.mjs",
    "test:storage": "node tools/scripts/test-storage.mjs",
    "test:activity": "node tools/scripts/test-activity.mjs",
    "test:providers": "node tools/scripts/test-providers.mjs",
    "test:cards": "node tools/scripts/test-cards.mjs",
    "test:prompt": "node tools/scripts/test-prompt.mjs",
    "test:runtime": "node tools/scripts/test-runtime.mjs",
    "test:ui": "node tools/scripts/test-ui.mjs",
    "test:host": "node tools/scripts/test-host.mjs"
  }
}
```

Replace `F:\git\Recursion\manifest.json` with:

```json
{
  "display_name": "Recursion",
  "version": "0.1.0-pre-alpha.1",
  "author": "MentallyQuill",
  "key": "recursion",
  "js": "src/extension/index.js",
  "css": "styles/recursion.css",
  "loading_order": 101,
  "generate_interceptor": "recursionGenerationInterceptor",
  "homePage": "https://github.com/MentallyQuill/Recursion",
  "minimum_client_version": "1.12.0",
  "auto_update": false,
  "hooks": {
    "install": "recursionOnInstall",
    "update": "recursionOnUpdate",
    "delete": "recursionOnDelete",
    "clean": "recursionOnClean",
    "enable": "recursionOnEnable",
    "disable": "recursionOnDisable",
    "activate": "recursionOnActivate"
  }
}
```

- [ ] **Step 2: Write the assertion helper and test runner**

Create `F:\git\Recursion\tests\helpers\assert.mjs`:

```js
export function assert(condition, message = 'Assertion failed') {
  if (!condition) throw new Error(message);
}

export function assertEqual(actual, expected, message = 'Values are not equal') {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertDeepEqual(actual, expected, message = 'Objects are not equal') {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) {
    throw new Error(`${message}: expected ${right}, got ${left}`);
  }
}

export async function assertRejects(fn, pattern, message = 'Expected rejection') {
  try {
    await fn();
  } catch (error) {
    if (!pattern || pattern.test(String(error?.message || error))) return;
    throw new Error(`${message}: ${error?.message || error}`);
  }
  throw new Error(message);
}
```

Create `F:\git\Recursion\tools\scripts\run-tests.mjs`:

```js
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scripts = readdirSync(here)
  .filter((name) => /^test-.*\.mjs$/.test(name) && name !== 'test-harness.mjs')
  .sort();

for (const script of scripts) {
  const started = Date.now();
  await import(pathToFileURL(join(here, script)).href);
  console.log(`[pass] ${script} ${Date.now() - started}ms`);
}
console.log(`[pass] ${scripts.length} test scripts`);
```

Create `F:\git\Recursion\tools\scripts\test-harness.mjs`:

```js
import { assert, assertEqual, assertDeepEqual, assertRejects } from '../../tests/helpers/assert.mjs';

assert(true, 'assert accepts true');
assertEqual(2 + 2, 4, 'math works');
assertDeepEqual({ a: 1 }, { a: 1 }, 'deep equality works');
await assertRejects(async () => {
  throw new Error('expected failure');
}, /expected failure/);

console.log('[pass] harness assertions');
```

- [ ] **Step 3: Verify the harness**

Run:

```powershell
npm run test:harness
```

Expected output contains:

```text
[pass] harness assertions
```

- [ ] **Step 4: Commit**

```powershell
git add package.json manifest.json tools/scripts/run-tests.mjs tools/scripts/test-harness.mjs tests/helpers/assert.mjs
git commit -m "chore: add Recursion extension harness"
```

---

### Task 2: Core Utilities And Redaction

**Files:**
- Create: `F:\git\Recursion\src\core.mjs`
- Create: `F:\git\Recursion\tools\scripts\test-core.mjs`

- [ ] **Step 1: Write failing core utility tests**

Create `F:\git\Recursion\tools\scripts\test-core.mjs`:

```js
import {
  cloneJson,
  compact,
  fnv1a,
  hashJson,
  parseJsonObject,
  redact,
  safeId,
  stableStringify,
  truncate
} from '../../src/core.mjs';
import { assert, assertEqual, assertDeepEqual, assertRejects } from '../../tests/helpers/assert.mjs';

assertDeepEqual(cloneJson({ a: 1 }), { a: 1 }, 'cloneJson clones plain objects');
assertEqual(compact('  a\n b\t c  '), 'a b c', 'compact normalizes whitespace');
assertEqual(truncate('abcdef', 4), 'a...', 'truncate caps strings');
assertEqual(safeId('Chat: One / Two'), 'Chat-One-Two', 'safeId removes unsafe characters');
assertEqual(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}', 'stableStringify sorts keys');
assertEqual(fnv1a('recursion'), fnv1a('recursion'), 'hash is stable');
assertEqual(hashJson({ a: 1 }), hashJson({ a: 1 }), 'json hash is stable');
assertDeepEqual(parseJsonObject('```json\n{"ok":true}\n```'), { ok: true }, 'parser accepts fenced json');

const redacted = redact({
  apiKey: 'secret',
  nested: { authorization: 'bearer token', keep: 'visible' },
  list: [{ password: 'secret2' }]
});
assertEqual(redacted.apiKey, '[redacted]', 'apiKey redacted');
assertEqual(redacted.nested.authorization, '[redacted]', 'authorization redacted');
assertEqual(redacted.nested.keep, 'visible', 'safe value preserved');
assertEqual(redacted.list[0].password, '[redacted]', 'nested array secret redacted');

await assertRejects(async () => parseJsonObject('not-json'), /valid JSON object/, 'invalid json rejects');
console.log('[pass] core utilities');
```

- [ ] **Step 2: Run the test and verify it fails because the module is missing**

Run:

```powershell
npm run test:core
```

Expected: FAIL with a module-not-found error for `src/core.mjs`.

- [ ] **Step 3: Implement the core utilities**

Create `F:\git\Recursion\src\core.mjs`:

```js
const SECRET_KEY_PATTERN = /(?:api[-_]?key|authorization|cookie|token|password|secret|session[-_]?key|bearer)/i;

export function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function compact(value, limit = 10000) {
  return truncate(String(value ?? '').replace(/\s+/g, ' ').trim(), limit);
}

export function truncate(value, limit = 200) {
  const text = String(value ?? '');
  const cap = Math.max(0, Number(limit) || 0);
  if (text.length <= cap) return text;
  if (cap <= 3) return '.'.repeat(cap);
  return `${text.slice(0, cap - 3)}...`;
}

export function safeId(value, fallback = 'item') {
  const text = String(value ?? '').trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return text || fallback;
}

export function stableStringify(value) {
  const seen = new WeakSet();
  function normalize(input) {
    if (!input || typeof input !== 'object') return input;
    if (seen.has(input)) return '[Circular]';
    seen.add(input);
    if (Array.isArray(input)) return input.map((entry) => normalize(entry));
    return Object.fromEntries(Object.keys(input).sort().map((key) => [key, normalize(input[key])]));
  }
  return JSON.stringify(normalize(value));
}

export function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (const char of String(value ?? '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function hashJson(value) {
  return fnv1a(stableStringify(value));
}

function stripFencedJson(text) {
  const source = String(text ?? '').trim();
  const match = source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : source;
}

export function parseJsonObject(value) {
  const source = stripFencedJson(value);
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    const wrapped = new Error(`Provider output is not valid JSON object: ${error.message}`);
    wrapped.code = 'RECURSION_JSON_PARSE_FAILED';
    throw wrapped;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = new Error('Provider output is not a valid JSON object.');
    error.code = 'RECURSION_JSON_OBJECT_REQUIRED';
    throw error;
  }
  return parsed;
}

export function redact(value, { maxString = 500 } = {}) {
  function visit(input, key = '') {
    if (SECRET_KEY_PATTERN.test(key)) return '[redacted]';
    if (typeof input === 'string') return truncate(input, maxString);
    if (!input || typeof input !== 'object') return input;
    if (Array.isArray(input)) return input.map((entry) => visit(entry));
    return Object.fromEntries(Object.entries(input).map(([childKey, child]) => [childKey, visit(child, childKey)]));
  }
  return visit(value);
}

export function nowIso() {
  return new Date().toISOString();
}

export function makeId(prefix = 'id') {
  return `${safeId(prefix)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}
```

- [ ] **Step 4: Verify core utilities pass**

Run:

```powershell
npm run test:core
```

Expected output contains:

```text
[pass] core utilities
```

- [ ] **Step 5: Commit**

```powershell
git add src/core.mjs tools/scripts/test-core.mjs
git commit -m "feat: add core utility contracts"
```

---

### Task 3: Settings And Session-Only Provider Secrets

**Files:**
- Create: `F:\git\Recursion\src\settings.mjs`
- Create: `F:\git\Recursion\tools\scripts\test-settings.mjs`

- [ ] **Step 1: Write failing settings tests**

Create `F:\git\Recursion\tools\scripts\test-settings.mjs`:

```js
import {
  DEFAULT_RECURSION_SETTINGS,
  createSessionSecretStore,
  createSettingsStore,
  normalizeProviderSettings,
  normalizeSettings
} from '../../src/settings.mjs';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

const normalized = normalizeSettings({
  mode: 'auto',
  strength: 'strong',
  reasonerUse: 'auto',
  providers: {
    utility: { source: 'openai-compatible', openAICompatible: { baseUrl: 'http://localhost:1234/v1', model: 'fast' }, temperature: 0.3 },
    reasoner: { enabled: true, source: 'host-current-model' }
  }
});
assertEqual(normalized.mode, 'auto', 'mode preserved');
assertEqual(normalized.providers.utility.openAICompatible.model, 'fast', 'utility model preserved');
assertEqual(normalized.providers.reasoner.enabled, true, 'reasoner enabled preserved');

const clamped = normalizeProviderSettings('utility', { temperature: 99, topP: -1, maxTokens: 9999999 });
assertEqual(clamped.temperature, 2, 'temperature clamped');
assertEqual(clamped.topP, 0, 'topP clamped');
assertEqual(clamped.maxTokens, 131072, 'maxTokens clamped');

const root = {};
const secrets = createSessionSecretStore();
const store = createSettingsStore({ root, secretStore: secrets });
store.update({ mode: 'observe' });
store.updateProvider('utility', { source: 'openai-compatible', apiKey: 'secret-key' });
assertEqual(store.get().mode, 'observe', 'settings update saved');
assertEqual(root.recursion.providers.utility.apiKey, undefined, 'api key is not persisted');
assertEqual(secrets.get('utility'), 'secret-key', 'api key stored in session secret store');
assertEqual(store.get().providers.utility.openAICompatible.sessionApiKeyPresent, true, 'secret presence reflected');
store.clearApiKey('utility');
assertEqual(secrets.get('utility'), '', 'secret cleared');
assert(DEFAULT_RECURSION_SETTINGS.providers.utility.enabled, 'utility default enabled');
console.log('[pass] settings');
```

- [ ] **Step 2: Run the test and verify it fails because the module is missing**

Run:

```powershell
npm run test:settings
```

Expected: FAIL with a module-not-found error for `src/settings.mjs`.

- [ ] **Step 3: Implement settings and session secrets**

Create `F:\git\Recursion\src\settings.mjs`:

```js
import { cloneJson } from './core.mjs';

const MODES = new Set(['off', 'observe', 'auto']);
const STRENGTHS = new Set(['light', 'balanced', 'strong']);
const FOOTPRINTS = new Set(['compact', 'normal', 'rich']);
const FOCUS = new Set(['balanced', 'character', 'continuity', 'prose', 'plot']);
const REASONER_USE = new Set(['off', 'auto', 'always']);
const SOURCES = new Set(['host-current-model', 'host-connection-profile', 'openai-compatible']);
const LANES = new Set(['utility', 'reasoner']);

export const DEFAULT_RECURSION_SETTINGS = Object.freeze({
  mode: 'observe',
  strength: 'balanced',
  promptFootprint: 'normal',
  focus: 'balanced',
  reasonerUse: 'auto',
  diagnostics: {
    maxJournalEntries: 100,
    includeExcerpts: false
  },
  providers: {
    utility: {
      lane: 'utility',
      enabled: true,
      source: 'host-current-model',
      hostConnectionProfileId: '',
      openAICompatible: { baseUrl: '', model: '', sessionApiKeyPresent: false },
      temperature: 0.1,
      topP: 0.95,
      maxTokens: 4096,
      lastTest: { status: 'not-run' }
    },
    reasoner: {
      lane: 'reasoner',
      enabled: false,
      source: 'host-current-model',
      hostConnectionProfileId: '',
      openAICompatible: { baseUrl: '', model: '', sessionApiKeyPresent: false },
      temperature: 0.4,
      topP: 0.95,
      maxTokens: 4096,
      lastTest: { status: 'not-run' }
    }
  },
  ui: {
    viewerOpen: false
  }
});

function enumValue(value, allowed, fallback) {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

function numberInRange(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function normalizeProviderSettings(lane, value = {}, secretStore = null) {
  const resolvedLane = LANES.has(lane) ? lane : 'utility';
  const defaults = DEFAULT_RECURSION_SETTINGS.providers[resolvedLane];
  const source = value && typeof value === 'object' ? value : {};
  const openAICompatible = source.openAICompatible && typeof source.openAICompatible === 'object'
    ? source.openAICompatible
    : {};
  const hasSecret = Boolean(secretStore?.get?.(resolvedLane));
  return {
    lane: resolvedLane,
    enabled: resolvedLane === 'utility' ? true : source.enabled === true,
    source: enumValue(source.source, SOURCES, defaults.source),
    hostConnectionProfileId: String(source.hostConnectionProfileId ?? defaults.hostConnectionProfileId).trim(),
    openAICompatible: {
      baseUrl: String(openAICompatible.baseUrl ?? defaults.openAICompatible.baseUrl).trim(),
      model: String(openAICompatible.model ?? defaults.openAICompatible.model).trim(),
      sessionApiKeyPresent: hasSecret || openAICompatible.sessionApiKeyPresent === true
    },
    temperature: numberInRange(source.temperature, defaults.temperature, 0, 2),
    topP: numberInRange(source.topP, defaults.topP, 0, 1),
    maxTokens: Math.round(numberInRange(source.maxTokens, defaults.maxTokens, 64, 131072)),
    resolvedProviderLabel: String(source.resolvedProviderLabel || '').trim(),
    resolvedModelLabel: String(source.resolvedModelLabel || '').trim(),
    lastTest: {
      status: enumValue(source.lastTest?.status, new Set(['pass', 'fail', 'not-run']), 'not-run'),
      checkedAt: source.lastTest?.checkedAt ? String(source.lastTest.checkedAt) : undefined,
      compactError: source.lastTest?.compactError ? String(source.lastTest.compactError).slice(0, 300) : undefined
    }
  };
}

export function normalizeSettings(value = {}, secretStore = null) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    mode: enumValue(source.mode, MODES, DEFAULT_RECURSION_SETTINGS.mode),
    strength: enumValue(source.strength, STRENGTHS, DEFAULT_RECURSION_SETTINGS.strength),
    promptFootprint: enumValue(source.promptFootprint, FOOTPRINTS, DEFAULT_RECURSION_SETTINGS.promptFootprint),
    focus: enumValue(source.focus, FOCUS, DEFAULT_RECURSION_SETTINGS.focus),
    reasonerUse: enumValue(source.reasonerUse, REASONER_USE, DEFAULT_RECURSION_SETTINGS.reasonerUse),
    diagnostics: {
      maxJournalEntries: Math.round(numberInRange(source.diagnostics?.maxJournalEntries, 100, 10, 500)),
      includeExcerpts: source.diagnostics?.includeExcerpts === true
    },
    providers: {
      utility: normalizeProviderSettings('utility', source.providers?.utility, secretStore),
      reasoner: normalizeProviderSettings('reasoner', source.providers?.reasoner, secretStore)
    },
    ui: {
      viewerOpen: source.ui?.viewerOpen === true
    }
  };
}

export function createSessionSecretStore() {
  const memory = new Map();
  return {
    get(lane) {
      return memory.get(String(lane || '')) || '';
    },
    set(lane, value) {
      const key = String(lane || '');
      const secret = String(value || '');
      if (secret) memory.set(key, secret);
      else memory.delete(key);
      return Boolean(secret);
    },
    clear(lane) {
      memory.delete(String(lane || ''));
    }
  };
}

export function createSettingsStore({ root = globalThis.extension_settings || {}, secretStore = createSessionSecretStore(), save = null } = {}) {
  if (!root.recursion || typeof root.recursion !== 'object') root.recursion = cloneJson(DEFAULT_RECURSION_SETTINGS);
  root.recursion = normalizeSettings(root.recursion, secretStore);

  function persist(next) {
    root.recursion = normalizeSettings(next, secretStore);
    if (typeof save === 'function') save();
    else if (typeof globalThis.saveSettingsDebounced === 'function') globalThis.saveSettingsDebounced();
    return cloneJson(root.recursion);
  }

  return {
    get() {
      root.recursion = normalizeSettings(root.recursion, secretStore);
      return cloneJson(root.recursion);
    },
    update(patch = {}) {
      return persist({ ...root.recursion, ...patch });
    },
    updateProvider(lane, patch = {}) {
      const current = this.get();
      const cleanPatch = { ...patch };
      if (Object.prototype.hasOwnProperty.call(cleanPatch, 'apiKey')) {
        secretStore.set(lane, cleanPatch.apiKey);
        delete cleanPatch.apiKey;
      }
      return persist({
        ...current,
        providers: {
          ...current.providers,
          [lane]: {
            ...current.providers[lane],
            ...cleanPatch
          }
        }
      }).providers[lane];
    },
    getApiKey(lane) {
      return secretStore.get(lane);
    },
    clearApiKey(lane) {
      secretStore.clear(lane);
      const current = this.get();
      return persist(current).providers[lane];
    }
  };
}
```

- [ ] **Step 4: Verify settings pass**

Run:

```powershell
npm run test:settings
```

Expected output contains:

```text
[pass] settings
```

- [ ] **Step 5: Commit**

```powershell
git add src/settings.mjs tools/scripts/test-settings.mjs
git commit -m "feat: add Recursion settings store"
```

---

### Task 4: Storage Repository And Sanitized Journals

**Files:**
- Create: `F:\git\Recursion\src\storage.mjs`
- Create: `F:\git\Recursion\tools\scripts\test-storage.mjs`

- [ ] **Step 1: Write failing storage tests**

Create `F:\git\Recursion\tools\scripts\test-storage.mjs`:

```js
import {
  createMemoryStorageAdapter,
  createStorageRepository,
  sceneCacheKey,
  runJournalKey
} from '../../src/storage.mjs';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

assertEqual(sceneCacheKey('Chat One', 'Scene/One'), 'recursion-scene-Chat-One-Scene-One.v1.json', 'scene key sanitized');
assertEqual(runJournalKey('Chat One'), 'recursion-run-journal-Chat-One.v1.json', 'journal key sanitized');

const adapter = createMemoryStorageAdapter();
const repo = createStorageRepository({ storage: adapter, maxJournalEntries: 2 });

await repo.saveSceneCache('Chat One', 'Scene One', {
  cacheState: 'active',
  cards: [{ id: 'card-1', promptText: 'keep', inspectorNotes: 'private' }]
});
const cache = await repo.loadSceneCache('Chat One', 'Scene One');
assertEqual(cache.cards[0].id, 'card-1', 'scene cache persisted');

await repo.appendJournal('Chat One', { event: 'provider.call.started', summary: 'one', details: { apiKey: 'secret' } });
await repo.appendJournal('Chat One', { event: 'provider.call.completed', summary: 'two' });
await repo.appendJournal('Chat One', { event: 'prompt.installed', summary: 'three' });
const journal = await repo.loadRunJournal('Chat One');
assertEqual(journal.entries.length, 2, 'journal pruned to max');
assertEqual(journal.entries[0].summary, 'two', 'oldest entry pruned');
assert(journal.entries.every((entry) => !JSON.stringify(entry).includes('secret')), 'journal redacts secrets');

console.log('[pass] storage');
```

- [ ] **Step 2: Run the test and verify it fails because the module is missing**

Run:

```powershell
npm run test:storage
```

Expected: FAIL with a module-not-found error for `src/storage.mjs`.

- [ ] **Step 3: Implement storage**

Create `F:\git\Recursion\src\storage.mjs`:

```js
import { cloneJson, makeId, nowIso, redact, safeId } from './core.mjs';

export const SYSTEM_INDEX_KEY = 'recursion-system-index.v1.json';

export function sceneCacheKey(chatKey, sceneKey) {
  return `recursion-scene-${safeId(chatKey, 'chat')}-${safeId(sceneKey, 'scene')}.v1.json`;
}

export function runJournalKey(chatKey) {
  return `recursion-run-journal-${safeId(chatKey, 'chat')}.v1.json`;
}

export function createMemoryStorageAdapter() {
  const files = new Map();
  return {
    async readJson(key) {
      return files.has(key) ? cloneJson(files.get(key)) : null;
    },
    async writeJson(key, value) {
      files.set(key, cloneJson(value));
      return { ok: true, key };
    },
    async deleteJson(key) {
      files.delete(key);
      return { ok: true, key };
    },
    dump() {
      return cloneJson(Object.fromEntries(files.entries()));
    }
  };
}

function baseRecord(recordType, extra = {}) {
  const now = nowIso();
  return {
    recordType,
    schemaVersion: 1,
    createdAt: extra.createdAt || now,
    updatedAt: now,
    recursionVersion: '0.1.0-pre-alpha.1',
    ...extra
  };
}

function normalizeSceneCache(chatKey, sceneKey, value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return baseRecord('recursion.sceneCache', {
    ...source,
    chatKey: safeId(chatKey, 'chat'),
    sceneKey: safeId(sceneKey, 'scene'),
    cacheState: ['active', 'stale', 'retired', 'invalid'].includes(source.cacheState) ? source.cacheState : 'active',
    cards: Array.isArray(source.cards) ? source.cards.map((card) => ({
      id: safeId(card.id || makeId('card')),
      family: String(card.family || 'unknown'),
      status: ['candidate', 'active', 'stowed', 'stale', 'discarded'].includes(card.status) ? card.status : 'active',
      summary: String(card.summary || '').slice(0, 400),
      promptText: String(card.promptText || '').slice(0, 1000),
      evidenceRefs: Array.isArray(card.evidenceRefs) ? card.evidenceRefs.map(String).slice(0, 12) : [],
      tokenEstimate: Math.max(0, Math.min(1000, Number(card.tokenEstimate) || 0)),
      emphasis: ['normal', 'emphasized', 'muted'].includes(card.emphasis) ? card.emphasis : 'normal',
      detailProfile: ['compact', 'standard', 'expanded'].includes(card.detailProfile) ? card.detailProfile : 'standard',
      generatedAt: card.generatedAt || nowIso(),
      sourceFingerprint: String(card.sourceFingerprint || ''),
      arbiterDecisionHash: card.arbiterDecisionHash ? String(card.arbiterDecisionHash) : undefined,
      inspectorNotes: card.inspectorNotes ? String(card.inspectorNotes).slice(0, 800) : undefined
    })) : [],
    latestHand: source.latestHand || null,
    source: source.source || null,
    versions: source.versions || {}
  });
}

function normalizeJournal(chatKey, value = {}, maxEntries = 100) {
  const source = value && typeof value === 'object' ? value : {};
  const entries = Array.isArray(source.entries) ? source.entries.slice(-maxEntries) : [];
  return baseRecord('recursion.runJournal', {
    ...source,
    chatKey: safeId(chatKey, 'chat'),
    maxEntries,
    nextIndex: Number(source.nextIndex || entries.length),
    entries
  });
}

export function createStorageRepository({ storage = createMemoryStorageAdapter(), maxJournalEntries = 100, activity = null } = {}) {
  async function writeIndexEntry(key, kind, chatKey = null) {
    const index = await storage.readJson(SYSTEM_INDEX_KEY) || baseRecord('recursion.systemIndex', { records: {} });
    index.records[key] = { key, kind, chatKey, updatedAt: nowIso() };
    index.updatedAt = nowIso();
    await storage.writeJson(SYSTEM_INDEX_KEY, index);
  }

  return {
    async loadSceneCache(chatKey, sceneKey) {
      const key = sceneCacheKey(chatKey, sceneKey);
      const existing = await storage.readJson(key);
      return existing ? normalizeSceneCache(chatKey, sceneKey, existing) : null;
    },
    async saveSceneCache(chatKey, sceneKey, value) {
      const key = sceneCacheKey(chatKey, sceneKey);
      activity?.stage?.({ phase: 'storageSaving', mode: 'background', severity: 'info', label: 'Saving scene cache...', detail: key });
      const record = normalizeSceneCache(chatKey, sceneKey, value);
      await storage.writeJson(key, record);
      await writeIndexEntry(key, 'sceneCache', safeId(chatKey, 'chat'));
      activity?.stage?.({ phase: 'storageComplete', mode: 'background', severity: 'success', label: 'Scene cache saved.' });
      return record;
    },
    async loadRunJournal(chatKey) {
      const key = runJournalKey(chatKey);
      return normalizeJournal(chatKey, await storage.readJson(key), maxJournalEntries);
    },
    async appendJournal(chatKey, entry) {
      const key = runJournalKey(chatKey);
      const journal = await this.loadRunJournal(chatKey);
      const clean = redact({
        id: entry.id || makeId('journal'),
        recordedAt: entry.recordedAt || nowIso(),
        severity: entry.severity || 'info',
        event: entry.event || 'runtime.event',
        summary: String(entry.summary || '').slice(0, 300),
        runId: entry.runId || undefined,
        sceneKey: entry.sceneKey || undefined,
        details: entry.details || undefined,
        hashes: entry.hashes || undefined,
        metrics: entry.metrics || undefined
      });
      journal.entries.push(clean);
      journal.entries = journal.entries.slice(-journal.maxEntries);
      journal.nextIndex += 1;
      journal.updatedAt = nowIso();
      await storage.writeJson(key, journal);
      await writeIndexEntry(key, 'runJournal', safeId(chatKey, 'chat'));
      return clean;
    },
    async clearSceneCache(chatKey, sceneKey) {
      const key = sceneCacheKey(chatKey, sceneKey);
      await storage.deleteJson(key);
      return { ok: true, key };
    },
    async readIndex() {
      return await storage.readJson(SYSTEM_INDEX_KEY) || baseRecord('recursion.systemIndex', { records: {} });
    }
  };
}
```

- [ ] **Step 4: Verify storage passes**

Run:

```powershell
npm run test:storage
```

Expected output contains:

```text
[pass] storage
```

- [ ] **Step 5: Commit**

```powershell
git add src/storage.mjs tools/scripts/test-storage.mjs
git commit -m "feat: add Recursion storage repository"
```

---

### Task 5: Activity Reporter

**Files:**
- Create: `F:\git\Recursion\src\activity.mjs`
- Create: `F:\git\Recursion\tools\scripts\test-activity.mjs`

- [ ] **Step 1: Write failing activity tests**

Create `F:\git\Recursion\tools\scripts\test-activity.mjs`:

```js
import { createActivityReporter } from '../../src/activity.mjs';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

const events = [];
const reporter = createActivityReporter({ onEvent: (event) => events.push(event) });
const run = reporter.start({ runId: 'run-1', label: 'Reading current turn...' });
reporter.stage({ runId: run.runId, phase: 'cardBatchRunning', label: 'Generating scene cards...', chips: ['Utility', 'Cards 3'] });
reporter.settle({ runId: run.runId, outcome: 'success', label: 'Recursion prompt ready.' });

assertEqual(events.length, 3, 'start, stage, settle emitted');
assertEqual(reporter.current().phase, 'settled', 'current state settled');
assertEqual(reporter.current().label, 'Recursion prompt ready.', 'settle label preserved');

reporter.stage({ runId: 'stale-run', phase: 'late', label: 'Late result' });
assert(!events.some((event) => event.runId === 'stale-run'), 'stale run ignored');
console.log('[pass] activity');
```

- [ ] **Step 2: Run the test and verify it fails because the module is missing**

Run:

```powershell
npm run test:activity
```

Expected: FAIL with a module-not-found error for `src/activity.mjs`.

- [ ] **Step 3: Implement the Activity Reporter**

Create `F:\git\Recursion\src\activity.mjs`:

```js
import { cloneJson, makeId, nowIso, redact, truncate } from './core.mjs';

function normalizeActivity(input = {}, fallbackRunId = null) {
  return redact({
    runId: input.runId || fallbackRunId || makeId('run'),
    phase: String(input.phase || 'active'),
    mode: ['foreground', 'background', 'review'].includes(input.mode) ? input.mode : 'foreground',
    severity: ['info', 'success', 'warning', 'error'].includes(input.severity) ? input.severity : 'info',
    label: truncate(input.label || 'Recursion is working...', 160),
    detail: input.detail ? truncate(input.detail, 240) : '',
    chips: Array.isArray(input.chips) ? input.chips.map((chip) => truncate(chip, 40)).slice(0, 8) : [],
    providerLane: ['utility', 'reasoner'].includes(input.providerLane) ? input.providerLane : undefined,
    composerLane: ['utility', 'reasoner', 'local'].includes(input.composerLane) ? input.composerLane : undefined,
    cardCounts: input.cardCounts || undefined,
    fallbackReason: input.fallbackReason ? truncate(input.fallbackReason, 160) : undefined,
    recordedAt: input.recordedAt || nowIso()
  });
}

export function createActivityReporter({ onEvent = null } = {}) {
  let activeRunId = null;
  let currentState = {
    runId: null,
    phase: 'idle',
    mode: 'background',
    severity: 'info',
    label: 'Recursion ready.',
    detail: '',
    chips: [],
    recordedAt: nowIso()
  };
  const history = [];

  function emit(event) {
    currentState = cloneJson(event);
    history.push(currentState);
    if (history.length > 100) history.splice(0, history.length - 100);
    onEvent?.(cloneJson(event));
    return cloneJson(event);
  }

  return {
    start(input = {}) {
      const event = normalizeActivity({
        phase: input.phase || 'started',
        mode: input.mode || 'foreground',
        severity: input.severity || 'info',
        label: input.label || 'Reading current turn...',
        detail: input.detail,
        chips: input.chips
      }, input.runId || makeId('run'));
      activeRunId = event.runId;
      return emit(event);
    },
    stage(input = {}) {
      if (activeRunId && input.runId && input.runId !== activeRunId) return cloneJson(currentState);
      const event = normalizeActivity(input, activeRunId || input.runId || makeId('run'));
      activeRunId = event.runId;
      return emit(event);
    },
    settle(input = {}) {
      if (activeRunId && input.runId && input.runId !== activeRunId) return cloneJson(currentState);
      const event = normalizeActivity({
        ...input,
        phase: 'settled',
        severity: input.outcome === 'error' ? 'error' : (input.outcome === 'warning' ? 'warning' : 'success'),
        label: input.label || 'Recursion prompt ready.'
      }, activeRunId || input.runId || makeId('run'));
      activeRunId = null;
      return emit(event);
    },
    current() {
      return cloneJson(currentState);
    },
    history() {
      return cloneJson(history);
    },
    clear() {
      activeRunId = null;
      return emit({
        runId: null,
        phase: 'idle',
        mode: 'background',
        severity: 'info',
        label: 'Recursion ready.',
        detail: '',
        chips: [],
        recordedAt: nowIso()
      });
    }
  };
}
```

- [ ] **Step 4: Verify activity passes**

Run:

```powershell
npm run test:activity
```

Expected output contains:

```text
[pass] activity
```

- [ ] **Step 5: Commit**

```powershell
git add src/activity.mjs tools/scripts/test-activity.mjs
git commit -m "feat: add Recursion activity reporter"
```

---

### Task 6: Provider Lanes, Structured Output, And Retries

**Files:**
- Create: `F:\git\Recursion\src\providers.mjs`
- Create: `F:\git\Recursion\tools\scripts\test-providers.mjs`

- [ ] **Step 1: Write failing provider tests**

Create `F:\git\Recursion\tools\scripts\test-providers.mjs`:

```js
import { createGenerationRouter, createProviderClient, parseStructuredOutput } from '../../src/providers.mjs';
import { createSettingsStore, createSessionSecretStore } from '../../src/settings.mjs';
import { assertEqual } from '../../tests/helpers/assert.mjs';

assertEqual(parseStructuredOutput('```json\n{"schema":"x"}\n```').schema, 'x', 'structured parser accepts fenced json');

const calls = [];
const host = {
  generation: {
    async generate(request) {
      calls.push(request);
      return { text: '{"schema":"recursion.test.v1","ok":true}', providerId: 'fake-host', model: 'fake-model' };
    },
    async batch(requests) {
      return Promise.all(requests.map((request) => this.generate(request)));
    }
  }
};
const settingsRoot = {};
const store = createSettingsStore({ root: settingsRoot, secretStore: createSessionSecretStore() });
const client = createProviderClient({ host, settingsStore: store });
const router = createGenerationRouter({ client });
const result = await router.generate('utilityArbiter', { prompt: 'Return JSON' });
assertEqual(result.ok, true, 'generation succeeds');
assertEqual(result.data.ok, true, 'json data parsed');
assertEqual(calls[0].lane, 'utility', 'utility lane selected');

store.update({ reasonerUse: 'always' });
store.updateProvider('reasoner', { enabled: true });
const reasoner = await router.generate('reasonerComposer', { prompt: 'Reason' });
assertEqual(reasoner.ok, true, 'reasoner route succeeds');
assertEqual(calls.at(-1).lane, 'reasoner', 'reasoner lane selected');

console.log('[pass] providers');
```

- [ ] **Step 2: Run the test and verify it fails because the module is missing**

Run:

```powershell
npm run test:providers
```

Expected: FAIL with a module-not-found error for `src/providers.mjs`.

- [ ] **Step 3: Implement provider lanes and router**

Create `F:\git\Recursion\src\providers.mjs`:

```js
import { compact, hashJson, parseJsonObject, redact, truncate } from './core.mjs';

const ROLE_LANES = Object.freeze({
  utilityArbiter: 'utility',
  sceneFrameCard: 'utility',
  activeCastCard: 'utility',
  characterMotivationCard: 'utility',
  dialogueRelationshipCard: 'utility',
  continuityRiskCard: 'utility',
  environmentItemsCard: 'utility',
  prosePacingCard: 'utility',
  openThreadsCard: 'utility',
  briefUtilityComposer: 'utility',
  reasonerComposer: 'reasoner',
  providerTest: 'utility'
});

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'RECURSION_PROVIDER_TIMEOUT',
  'RECURSION_PROVIDER_TRANSPORT'
]);

export function roleLane(roleId) {
  return ROLE_LANES[roleId] || 'utility';
}

export function parseStructuredOutput(text) {
  return parseJsonObject(text);
}

function normalizeText(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value?.text === 'string') return value.text.trim();
  if (typeof value?.content === 'string') return value.content.trim();
  if (typeof value?.choices?.[0]?.message?.content === 'string') return value.choices[0].message.content.trim();
  return '';
}

function isTransient(error) {
  const code = String(error?.code || error?.cause?.code || '').toUpperCase();
  return TRANSIENT_CODES.has(code) || /timed out|network|fetch failed|connection/i.test(String(error?.message || ''));
}

async function withTimeout(promise, timeoutMs, signal = null) {
  if (signal?.aborted) throw Object.assign(new Error('Generation aborted'), { code: 'RECURSION_ABORTED' });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Provider call timed out'), { code: 'RECURSION_PROVIDER_TIMEOUT' })), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createProviderClient({ host, settingsStore, fetchImpl = globalThis.fetch } = {}) {
  async function sendOpenAI(config, request, apiKey) {
    const endpoint = `${String(config.openAICompatible.baseUrl || '').replace(/\/+$/, '')}/chat/completions`.replace(/\/v1\/chat\/completions\/chat\/completions$/, '/v1/chat/completions');
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: config.openAICompatible.model,
        temperature: config.temperature,
        top_p: config.topP,
        max_tokens: request.maxTokens || config.maxTokens,
        messages: [
          ...(request.systemPrompt ? [{ role: 'system', content: request.systemPrompt }] : []),
          { role: 'user', content: request.prompt || JSON.stringify(request.payload || {}) }
        ]
      }),
      signal: request.signal
    });
    if (!response.ok) throw Object.assign(new Error(`OpenAI-compatible provider failed with ${response.status}`), { code: 'RECURSION_PROVIDER_HTTP' });
    const json = await response.json();
    return { text: normalizeText(json), providerId: 'openai-compatible', model: config.openAICompatible.model };
  }

  async function generate(roleId, request = {}) {
    const settings = settingsStore.get();
    const lane = request.lane || roleLane(roleId);
    const config = settings.providers[lane];
    if (!config?.enabled && lane === 'reasoner') {
      throw Object.assign(new Error('Reasoner provider is disabled.'), { code: 'RECURSION_REASONER_DISABLED', retryable: false });
    }
    if (config.source === 'openai-compatible') {
      const apiKey = settingsStore.getApiKey(lane);
      if (!apiKey) throw Object.assign(new Error(`${lane} OpenAI-compatible session key is missing.`), { code: 'RECURSION_PROVIDER_KEY_MISSING', retryable: false });
      return sendOpenAI(config, request, apiKey);
    }
    if (typeof host?.generation?.generate === 'function') {
      return host.generation.generate({ ...request, roleId, lane, providerSource: config.source, providerConfig: config });
    }
    throw Object.assign(new Error('Host generation is unavailable.'), { code: 'RECURSION_PROVIDER_UNAVAILABLE' });
  }

  async function batch(requests = []) {
    if (typeof host?.generation?.batch === 'function') {
      return host.generation.batch(requests);
    }
    const results = [];
    for (const request of requests) results.push(await generate(request.roleId, request));
    return results;
  }

  return { generate, batch };
}

export function createGenerationRouter({ client, activity = null, journal = null, timeoutMs = 45000 } = {}) {
  async function generate(roleId, request = {}, options = {}) {
    const lane = options.lane || roleLane(roleId);
    const requestHash = hashJson(redact({ roleId, lane, request }));
    const attempts = [];
    const started = Date.now();
    activity?.stage?.({ runId: request.runId, phase: 'providerCall', label: lane === 'reasoner' ? 'Reasoner composing final brief...' : 'Utility model call running...', providerLane: lane, chips: [lane === 'reasoner' ? 'Reasoner' : 'Utility'] });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await withTimeout(client.generate(roleId, { ...request, lane }), options.timeoutMs || timeoutMs, request.signal);
        const text = normalizeText(response);
        const data = parseStructuredOutput(text);
        const result = {
          ok: true,
          roleId,
          lane,
          data,
          text,
          diagnostics: {
            requestHash,
            responseHash: hashJson(data),
            providerId: response.providerId || null,
            model: response.model || null,
            latencyMs: Date.now() - started,
            retryCount: attempt
          }
        };
        await journal?.({ event: 'provider.call.completed', severity: 'info', summary: `${roleId} completed`, details: result.diagnostics });
        return result;
      } catch (error) {
        attempts.push(error);
        if (attempt === 0 && isTransient(error)) continue;
        const failed = {
          ok: false,
          roleId,
          lane,
          error: {
            code: error?.code || 'RECURSION_PROVIDER_FAILED',
            message: truncate(error?.message || String(error), 240),
            retryable: isTransient(error)
          },
          diagnostics: {
            requestHash,
            latencyMs: Date.now() - started,
            retryCount: attempt,
            attempts: attempts.length
          }
        };
        await journal?.({ event: 'provider.call.failed', severity: 'warn', summary: `${roleId} failed`, details: failed.error });
        activity?.stage?.({ runId: request.runId, phase: 'providerFailed', mode: 'review', severity: 'warning', label: `${lane === 'reasoner' ? 'Reasoner' : 'Utility'} provider failed.`, fallbackReason: failed.error.code });
        return failed;
      }
    }
  }

  async function batch(requests = [], options = {}) {
    const results = [];
    for (const request of requests) {
      results.push(await generate(request.roleId, request, options));
    }
    return results;
  }

  return { generate, batch };
}
```

- [ ] **Step 4: Verify providers pass**

Run:

```powershell
npm run test:providers
```

Expected output contains:

```text
[pass] providers
```

- [ ] **Step 5: Commit**

```powershell
git add src/providers.mjs tools/scripts/test-providers.mjs
git commit -m "feat: add provider lanes and generation router"
```

---

### Task 7: V1 Card Catalog, Deck, And Hand Selection

**Files:**
- Create: `F:\git\Recursion\src\cards.mjs`
- Create: `F:\git\Recursion\tools\scripts\test-cards.mjs`

- [ ] **Step 1: Write failing card tests**

Create `F:\git\Recursion\tools\scripts\test-cards.mjs`:

```js
import {
  CARD_CATALOG,
  applyCardPlan,
  buildCardRequests,
  normalizeCard,
  selectHand
} from '../../src/cards.mjs';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

assertEqual(CARD_CATALOG.length, 8, 'full V1 catalog present');
const card = normalizeCard({
  family: 'Character Motivation',
  promptText: 'Mara appears guarded after the accusation.',
  inspectorNotes: 'Do not inject this note.',
  evidenceRefs: ['message:4']
}, { sceneId: 'scene-1', snapshotHash: 'hash' });
assertEqual(card.status, 'active', 'card active by default');
assertEqual(card.family, 'Character Motivation', 'family preserved');

const deck = applyCardPlan([], {
  acceptedCards: [card],
  lifecycle: [{ action: 'select', cardId: card.id, reason: 'relevant' }]
});
assertEqual(deck.cards.length, 1, 'deck has card');
assertEqual(deck.cards[0].arbiter.reason, 'relevant', 'arbiter reason applied');

const requests = buildCardRequests({ cardJobs: [{ role: 'sceneFrameCard' }, { role: 'continuityRiskCard' }] }, { runId: 'run', snapshotHash: 'hash' });
assertEqual(requests.length, 2, 'card requests built');

const hand = selectHand(deck.cards, { maxCards: 4, maxTokens: 500 });
assertEqual(hand.cards.length, 1, 'hand selected card');
assert(!hand.cards[0].inspectorNotes, 'hand excludes inspector notes');
console.log('[pass] cards');
```

- [ ] **Step 2: Run the test and verify it fails because the module is missing**

Run:

```powershell
npm run test:cards
```

Expected: FAIL with a module-not-found error for `src/cards.mjs`.

- [ ] **Step 3: Implement cards**

Create `F:\git\Recursion\src\cards.mjs`:

```js
import { compact, hashJson, makeId, nowIso, safeId, truncate } from './core.mjs';

export const CARD_CATALOG = Object.freeze([
  { family: 'Scene Frame', role: 'sceneFrameCard', priority: 100, description: 'Current location, situation, participants, and immediate dramatic direction.' },
  { family: 'Active Cast', role: 'activeCastCard', priority: 95, description: 'Who is present, visible state, and current role.' },
  { family: 'Character Motivation', role: 'characterMotivationCard', priority: 88, description: 'Observable or safely inferred motives and pressures.' },
  { family: 'Dialogue/Relationship', role: 'dialogueRelationshipCard', priority: 84, description: 'Conversational tension, relationship texture, and voice constraints.' },
  { family: 'Continuity Risk', role: 'continuityRiskCard', priority: 98, description: 'Fragile facts likely to be contradicted if omitted.' },
  { family: 'Environment/Items', role: 'environmentItemsCard', priority: 76, description: 'Spatial constraints, sensory details, objects, tools, hazards, and affordances.' },
  { family: 'Prose/Pacing', role: 'prosePacingCard', priority: 62, description: 'Local craft guidance for density, momentum, specificity, and response shape.' },
  { family: 'Open Threads', role: 'openThreadsCard', priority: 72, description: 'Unresolved questions, immediate promises, pending actions, and near-term pressures.' }
]);

const FAMILY_BY_ROLE = Object.fromEntries(CARD_CATALOG.map((entry) => [entry.role, entry.family]));
const CATALOG_BY_FAMILY = Object.fromEntries(CARD_CATALOG.map((entry) => [entry.family, entry]));
const STATUS = new Set(['candidate', 'active', 'stowed', 'stale', 'discarded']);
const EMPHASIS = new Set(['normal', 'emphasized', 'muted']);
const DETAIL = new Set(['compact', 'standard', 'expanded']);

export function normalizeCard(input = {}, context = {}) {
  const family = CATALOG_BY_FAMILY[input.family] ? input.family : (FAMILY_BY_ROLE[input.role] || 'Scene Frame');
  const promptText = compact(input.promptText || input.text || input.claim || '', 1000);
  if (!promptText) throw new Error('Card promptText is required.');
  const id = safeId(input.id || `${safeId(family)}-${hashJson({ promptText, context })}`, makeId('card'));
  return {
    id,
    schemaVersion: 1,
    family,
    sceneId: String(input.sceneId || context.sceneId || 'scene'),
    catalogKey: safeId(family),
    status: STATUS.has(input.status) ? input.status : 'active',
    source: {
      chatId: String(input.source?.chatId || context.chatId || ''),
      firstMesId: Number(input.source?.firstMesId ?? context.firstMesId ?? 0),
      lastMesId: Number(input.source?.lastMesId ?? context.lastMesId ?? 0),
      fingerprint: String(input.source?.fingerprint || context.snapshotHash || '')
    },
    promptText,
    summary: truncate(compact(input.summary || promptText, 400), 400),
    evidenceRefs: Array.isArray(input.evidenceRefs) ? input.evidenceRefs.map(String).slice(0, 12) : [],
    tokenEstimate: Math.max(1, Math.min(1000, Number(input.tokenEstimate || Math.ceil(promptText.length / 4)))),
    detailProfile: DETAIL.has(input.detailProfile) ? input.detailProfile : 'standard',
    emphasis: EMPHASIS.has(input.emphasis) ? input.emphasis : 'normal',
    freshness: {
      generatedAt: input.freshness?.generatedAt || nowIso(),
      sourceFingerprint: String(input.freshness?.sourceFingerprint || context.snapshotHash || ''),
      expiresAfterMesId: input.freshness?.expiresAfterMesId
    },
    arbiter: {
      lastDecisionId: String(input.arbiter?.lastDecisionId || context.decisionId || ''),
      reason: truncate(input.arbiter?.reason || input.reason || '', 240)
    },
    inspectorNotes: input.inspectorNotes ? truncate(input.inspectorNotes, 800) : undefined
  };
}

export function buildCardRequests(plan = {}, context = {}) {
  return (Array.isArray(plan.cardJobs) ? plan.cardJobs : [])
    .map((job) => ({
      roleId: job.role,
      runId: context.runId,
      snapshotHash: context.snapshotHash,
      prompt: [
        `Create one compact ${FAMILY_BY_ROLE[job.role] || job.role} card for the current scene.`,
        'Return JSON only with schema "recursion.card.v1".',
        `Snapshot:\n${JSON.stringify(context.snapshot || {}, null, 2)}`
      ].join('\n\n'),
      metadata: { family: FAMILY_BY_ROLE[job.role] || job.role, reason: job.reason || '' }
    }))
    .filter((request) => request.roleId);
}

export function cardsFromProviderResult(result, context = {}) {
  if (!result?.ok) return [];
  const items = Array.isArray(result.data.items) ? result.data.items : [];
  return items.map((item) => normalizeCard({
    role: result.roleId,
    family: result.data.family || FAMILY_BY_ROLE[result.roleId],
    promptText: item.promptText || item.text || item.claim,
    summary: item.summary,
    evidenceRefs: item.evidence || item.evidenceRefs,
    tokenEstimate: item.tokenCost || item.tokenEstimate,
    emphasis: item.emphasis,
    detailProfile: item.detailProfile,
    inspectorNotes: item.inspectorNotes
  }, context));
}

export function applyCardPlan(existingCards = [], plan = {}) {
  const byId = new Map(existingCards.map((card) => [card.id, { ...card }]));
  for (const card of plan.acceptedCards || []) byId.set(card.id, normalizeCard(card, card));
  for (const action of plan.lifecycle || []) {
    const card = byId.get(action.cardId);
    if (!card) continue;
    if (action.action === 'stow') card.status = 'stowed';
    if (action.action === 'discard') card.status = 'discarded';
    if (action.action === 'regenerate') card.status = 'stale';
    if (action.action === 'select' || action.action === 'emphasize') card.status = 'active';
    if (action.action === 'emphasize') card.emphasis = 'emphasized';
    card.arbiter = { lastDecisionId: action.decisionId || '', reason: truncate(action.reason || '', 240) };
    byId.set(card.id, card);
  }
  return { cards: [...byId.values()] };
}

export function selectHand(cards = [], { maxCards = 6, maxTokens = 700 } = {}) {
  const priority = { emphasized: 0, normal: 1, muted: 2 };
  const selected = [];
  const omitted = [];
  let tokens = 0;
  const candidates = cards
    .filter((card) => card.status === 'active')
    .sort((a, b) => (priority[a.emphasis] ?? 1) - (priority[b.emphasis] ?? 1));
  for (const card of candidates) {
    if (selected.length >= maxCards || tokens + card.tokenEstimate > maxTokens) {
      omitted.push({ cardId: card.id, reason: 'budget_exceeded' });
      continue;
    }
    tokens += card.tokenEstimate;
    const { inspectorNotes, ...safeCard } = card;
    selected.push(safeCard);
  }
  return {
    handId: makeId('hand'),
    cards: selected,
    omitted,
    tokenEstimate: tokens,
    composedAt: nowIso()
  };
}
```

- [ ] **Step 4: Verify cards pass**

Run:

```powershell
npm run test:cards
```

Expected output contains:

```text
[pass] cards
```

- [ ] **Step 5: Commit**

```powershell
git add src/cards.mjs tools/scripts/test-cards.mjs
git commit -m "feat: add Recursion card catalog and hand selection"
```

---

### Task 8: Prompt Packet Composition With Reasoner Fallback

**Files:**
- Create: `F:\git\Recursion\src\prompt.mjs`
- Create: `F:\git\Recursion\tools\scripts\test-prompt.mjs`

- [ ] **Step 1: Write failing prompt tests**

Create `F:\git\Recursion\tools\scripts\test-prompt.mjs`:

```js
import { composePromptPacket, packetToPromptBlocks, validatePromptPacket } from '../../src/prompt.mjs';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

const hand = {
  handId: 'hand-1',
  cards: [
    { id: 'c1', family: 'Scene Frame', promptText: 'The scene is in a rain-soaked alley.', emphasis: 'normal', tokenEstimate: 12 },
    { id: 'c2', family: 'Continuity Risk', promptText: 'The lamp is broken and should not provide light.', emphasis: 'emphasized', tokenEstimate: 12 }
  ],
  omitted: []
};
const packet = await composePromptPacket({
  hand,
  snapshot: { chatId: 'chat', sceneFingerprint: 'scene', turnFingerprint: 'turn' },
  settings: { promptFootprint: 'normal', reasonerUse: 'off' }
});
validatePromptPacket(packet);
assert(packet.sections.guardrails.includes('lamp'), 'continuity risk becomes guardrail');
const blocks = packetToPromptBlocks(packet);
assertEqual(blocks.length, 3, 'three prompt blocks produced');

const reasonerPacket = await composePromptPacket({
  hand,
  snapshot: { chatId: 'chat', sceneFingerprint: 'scene', turnFingerprint: 'turn' },
  settings: { promptFootprint: 'rich', reasonerUse: 'always' },
  generationRouter: {
    async generate() {
      return { ok: true, data: { schema: 'recursion.reasonerComposer.v1', instructionPatch: 'Fuse the alley mood with the broken lamp constraint.', keptCardIds: ['c1', 'c2'], droppedCardIds: [] } };
    }
  }
});
assertEqual(reasonerPacket.diagnostics.composerLane, 'reasoner', 'reasoner composer used');
console.log('[pass] prompt');
```

- [ ] **Step 2: Run the test and verify it fails because the module is missing**

Run:

```powershell
npm run test:prompt
```

Expected: FAIL with a module-not-found error for `src/prompt.mjs`.

- [ ] **Step 3: Implement prompt composition**

Create `F:\git\Recursion\src\prompt.mjs`:

```js
import { compact, hashJson, makeId, nowIso, truncate } from './core.mjs';

const FOOTPRINT_BUDGETS = Object.freeze({
  compact: { scene: 260, turn: 260, guardrails: 180, total: 700 },
  normal: { scene: 500, turn: 450, guardrails: 260, total: 1100 },
  rich: { scene: 800, turn: 700, guardrails: 360, total: 1600 }
});

function sectionJoin(lines, limit) {
  const output = [];
  let used = 0;
  for (const line of lines.map((entry) => compact(entry, 500)).filter(Boolean)) {
    if (used + line.length > limit) break;
    output.push(line);
    used += line.length;
  }
  return output.join('\n');
}

function familyLane(card) {
  if (card.family === 'Continuity Risk') return 'guardrails';
  if (card.family === 'Scene Frame' || card.family === 'Active Cast' || card.family === 'Environment/Items') return 'sceneBrief';
  return 'turnBrief';
}

function utilitySections(hand, footprint) {
  const budget = FOOTPRINT_BUDGETS[footprint] || FOOTPRINT_BUDGETS.normal;
  const scene = [];
  const turn = [];
  const guardrails = [
    'Respect the user message as story input; do not rewrite it or decide player intent.',
    'Do not expose hidden chain-of-thought, private motives, spoilers, or future plot plans.'
  ];
  for (const card of hand.cards || []) {
    const line = `- ${card.promptText}`;
    const lane = familyLane(card);
    if (lane === 'sceneBrief') scene.push(line);
    else if (lane === 'guardrails') guardrails.push(line);
    else turn.push(line);
  }
  return {
    sceneBrief: sectionJoin(scene, budget.scene),
    turnBrief: sectionJoin(turn, budget.turn),
    guardrails: sectionJoin(guardrails, budget.guardrails)
  };
}

async function maybeReasonerPatch({ hand, snapshot, settings, generationRouter, runId }) {
  if (!generationRouter || settings.reasonerUse === 'off') return null;
  if (settings.reasonerUse !== 'always' && settings.promptFootprint !== 'rich') return null;
  const result = await generationRouter.generate('reasonerComposer', {
    runId,
    prompt: [
      'Fuse the selected Recursion hand into one compact instruction patch.',
      'Return JSON only with schema "recursion.reasonerComposer.v1".',
      `Snapshot: ${JSON.stringify(snapshot)}`,
      `Cards: ${JSON.stringify(hand.cards || [])}`
    ].join('\n\n')
  });
  if (!result?.ok || result.data?.schema !== 'recursion.reasonerComposer.v1') return { failed: true, reason: result?.error?.code || 'reasoner_invalid' };
  return result.data;
}

export async function composePromptPacket({ hand, snapshot, settings, generationRouter = null, activity = null, runId = makeId('run') } = {}) {
  const footprint = ['compact', 'normal', 'rich'].includes(settings?.promptFootprint) ? settings.promptFootprint : 'normal';
  activity?.stage?.({ runId, phase: 'utilityComposing', label: 'Composing prompt packet with Utility...', composerLane: 'utility', chips: ['Utility'] });
  const sections = utilitySections(hand || { cards: [] }, footprint);
  let composerLane = 'utility';
  const reasoner = await maybeReasonerPatch({ hand, snapshot, settings: settings || {}, generationRouter, runId });
  if (reasoner?.instructionPatch) {
    activity?.stage?.({ runId, phase: 'reasonerComposing', label: 'Reasoner composing final brief...', composerLane: 'reasoner', chips: ['Reasoner'] });
    sections.turnBrief = sectionJoin([sections.turnBrief, `Reasoner synthesis: ${reasoner.instructionPatch}`], FOOTPRINT_BUDGETS[footprint].turn);
    composerLane = 'reasoner';
  } else if (reasoner?.failed) {
    activity?.stage?.({ runId, phase: 'reasonerFallback', severity: 'warning', label: 'Reasoner unavailable. Utility composed the packet.', fallbackReason: reasoner.reason });
  }
  const packet = {
    packetId: makeId('packet'),
    packetVersion: 1,
    chatId: snapshot?.chatId || '',
    sceneFingerprint: snapshot?.sceneFingerprint || '',
    turnFingerprint: snapshot?.turnFingerprint || '',
    footprint,
    sections,
    selectedCardRefs: (hand?.cards || []).map((card) => ({ cardId: card.id, family: card.family, emphasis: card.emphasis || 'normal' })),
    omissions: hand?.omitted || [],
    injectionPlan: {
      blocks: [
        { id: 'sceneBrief', promptKey: 'recursion.sceneBrief', title: 'Recursion Scene Brief', placement: 'in_prompt', depth: 4, role: 'system' },
        { id: 'turnBrief', promptKey: 'recursion.turnBrief', title: 'Recursion Turn Brief', placement: 'in_chat', depth: 2, role: 'system' },
        { id: 'guardrails', promptKey: 'recursion.guardrails', title: 'Recursion Guardrails', placement: 'in_prompt', depth: 1, role: 'system' }
      ]
    },
    diagnostics: {
      runId,
      composerLane,
      reasonerStatus: composerLane === 'reasoner' ? 'used' : (reasoner?.failed ? 'fallback' : 'skipped'),
      tokenEstimate: Math.ceil(JSON.stringify(sections).length / 4),
      packetHash: ''
    },
    composedAt: nowIso()
  };
  packet.diagnostics.packetHash = hashJson(packet.sections);
  validatePromptPacket(packet);
  activity?.stage?.({ runId, phase: 'promptPacketBuilt', label: 'Recursion prompt ready.', composerLane, chips: [composerLane === 'reasoner' ? 'Reasoner' : 'Utility', `Hand ${(hand?.cards || []).length}`] });
  return packet;
}

export function validatePromptPacket(packet) {
  if (!packet || typeof packet !== 'object') throw new Error('Prompt packet is required.');
  for (const field of ['packetId', 'chatId', 'sceneFingerprint', 'turnFingerprint']) {
    if (typeof packet[field] !== 'string') throw new Error(`Prompt packet ${field} must be a string.`);
  }
  if (!packet.sections || typeof packet.sections !== 'object') throw new Error('Prompt packet sections are required.');
  for (const key of ['sceneBrief', 'turnBrief', 'guardrails']) {
    if (typeof packet.sections[key] !== 'string') throw new Error(`Prompt packet section ${key} must be a string.`);
  }
  if (/chain-of-thought|private reasoning/i.test(JSON.stringify(packet.sections))) {
    throw new Error('Prompt packet contains disallowed hidden reasoning wording.');
  }
  return packet;
}

export function packetToPromptBlocks(packet) {
  validatePromptPacket(packet);
  return packet.injectionPlan.blocks.map((block) => ({
    ...block,
    text: truncate(packet.sections[block.id] || '', 3000),
    hash: hashJson({ id: block.id, text: packet.sections[block.id] || '' }),
    sourceIds: packet.selectedCardRefs.map((ref) => ref.cardId)
  }));
}
```

- [ ] **Step 4: Verify prompt composition passes**

Run:

```powershell
npm run test:prompt
```

Expected output contains:

```text
[pass] prompt
```

- [ ] **Step 5: Commit**

```powershell
git add src/prompt.mjs tools/scripts/test-prompt.mjs
git commit -m "feat: add prompt packet composition"
```

---

### Task 9: Runtime Coordinator

**Files:**
- Create: `F:\git\Recursion\src\runtime.mjs`
- Create: `F:\git\Recursion\tools\scripts\test-runtime.mjs`

- [ ] **Step 1: Write failing runtime tests**

Create `F:\git\Recursion\tools\scripts\test-runtime.mjs`:

```js
import { createRecursionRuntime } from '../../src/runtime.mjs';
import { createActivityReporter } from '../../src/activity.mjs';
import { createSettingsStore } from '../../src/settings.mjs';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

const installed = [];
const host = {
  async snapshot() {
    return {
      chatId: 'chat-1',
      chatKey: 'chat-1',
      sceneKey: 'scene-1',
      sceneFingerprint: 'scene-fp',
      turnFingerprint: 'turn-fp',
      latestMesId: 2,
      messages: [{ mesid: 1, role: 'user', text: 'The lamp breaks.' }]
    };
  },
  prompt: {
    async install(packet) {
      installed.push(packet);
      return { ok: true };
    },
    async clear() {
      installed.push({ cleared: true });
      return { ok: true };
    }
  }
};

const settingsStore = createSettingsStore({ root: {} });
settingsStore.update({ mode: 'auto', reasonerUse: 'off' });
const activity = createActivityReporter();
const runtime = createRecursionRuntime({ host, settingsStore, activity });
await runtime.prepareForGeneration({ userMessage: 'The lamp breaks.' });
assertEqual(installed.length, 1, 'prompt installed');
assert(runtime.view().lastHand.cards.length > 0, 'hand available');
assertEqual(runtime.view().activity.label, 'Recursion prompt ready.', 'activity settled');

settingsStore.update({ mode: 'observe' });
await runtime.prepareForGeneration({ userMessage: 'Observe only.' });
assertEqual(installed.length, 1, 'observe mode does not install');
console.log('[pass] runtime');
```

- [ ] **Step 2: Run the test and verify it fails because the module is missing**

Run:

```powershell
npm run test:runtime
```

Expected: FAIL with a module-not-found error for `src/runtime.mjs`.

- [ ] **Step 3: Implement runtime coordinator**

Create `F:\git\Recursion\src\runtime.mjs`:

```js
import { createActivityReporter } from './activity.mjs';
import { CARD_CATALOG, applyCardPlan, normalizeCard, selectHand } from './cards.mjs';
import { hashJson, makeId, nowIso } from './core.mjs';
import { composePromptPacket } from './prompt.mjs';
import { createSettingsStore } from './settings.mjs';
import { createMemoryStorageAdapter, createStorageRepository } from './storage.mjs';

function localFallbackPlan(snapshot, settings) {
  return {
    schema: 'recursion.utilityArbiter.v1',
    snapshotHash: hashJson(snapshot),
    action: 'compose-brief',
    sceneStatus: 'same-scene',
    cardJobs: [],
    reasonerDecision: { mode: settings.reasonerUse === 'always' ? 'use' : 'skip', reason: 'local fallback', signals: [] },
    budgets: { targetBriefTokens: settings.promptFootprint === 'rich' ? 900 : 500, maxCards: 6 },
    diagnostics: ['local-fallback-plan']
  };
}

function localCards(snapshot) {
  const latest = snapshot.messages?.at(-1)?.text || '';
  const scene = normalizeCard({
    family: 'Scene Frame',
    promptText: `Current scene context: ${latest || 'continue the visible scene without broad recap.'}`,
    evidenceRefs: [`message:${snapshot.latestMesId || 0}`],
    emphasis: 'normal'
  }, { sceneId: snapshot.sceneKey, chatId: snapshot.chatId, snapshotHash: hashJson(snapshot), lastMesId: snapshot.latestMesId });
  const continuity = normalizeCard({
    family: 'Continuity Risk',
    promptText: 'Keep the next response consistent with the latest visible user action and current scene state.',
    evidenceRefs: [`message:${snapshot.latestMesId || 0}`],
    emphasis: 'emphasized'
  }, { sceneId: snapshot.sceneKey, chatId: snapshot.chatId, snapshotHash: hashJson(snapshot), lastMesId: snapshot.latestMesId });
  return [scene, continuity];
}

export function createRecursionRuntime({
  host,
  settingsStore = createSettingsStore({ root: {} }),
  storage = createStorageRepository({ storage: createMemoryStorageAdapter() }),
  activity = createActivityReporter(),
  generationRouter = null
} = {}) {
  let activeRunId = null;
  let lastPacket = null;
  let lastHand = { cards: [], omitted: [] };
  let lastPlan = null;
  let lastSnapshot = null;

  async function snapshot() {
    const snap = await host.snapshot();
    return {
      chatId: String(snap.chatId || snap.chatKey || 'chat'),
      chatKey: String(snap.chatKey || snap.chatId || 'chat'),
      sceneKey: String(snap.sceneKey || snap.sceneFingerprint || 'scene'),
      sceneFingerprint: String(snap.sceneFingerprint || hashJson(snap.messages || [])),
      turnFingerprint: String(snap.turnFingerprint || hashJson({ latestMesId: snap.latestMesId, messages: snap.messages?.slice(-3) || [] })),
      latestMesId: Number(snap.latestMesId || 0),
      messages: Array.isArray(snap.messages) ? snap.messages : []
    };
  }

  async function prepareForGeneration({ userMessage = '' } = {}) {
    const settings = settingsStore.get();
    if (settings.mode === 'off') {
      await host.prompt?.clear?.();
      activity.clear();
      return { ok: true, skipped: true, reason: 'off' };
    }
    const runId = makeId('run');
    activeRunId = runId;
    activity.start({ runId, label: 'Reading current turn...', chips: ['Auto'] });
    const snap = await snapshot();
    lastSnapshot = snap;
    activity.stage({ runId, phase: 'arbiterPlanning', label: 'Planning card pass...', providerLane: 'utility', chips: ['Utility'] });
    let plan = localFallbackPlan({ ...snap, userMessage, catalog: CARD_CATALOG }, settings);
    if (generationRouter) {
      const arbiter = await generationRouter.generate('utilityArbiter', {
        runId,
        prompt: [
          'Return a Recursion Utility Arbiter plan as strict JSON.',
          `Catalog: ${JSON.stringify(CARD_CATALOG)}`,
          `Snapshot: ${JSON.stringify(snap)}`
        ].join('\n\n')
      });
      if (arbiter?.ok) plan = { ...plan, ...arbiter.data };
    }
    lastPlan = plan;
    activity.stage({ runId, phase: 'cardBatchRunning', label: plan.cardJobs?.length ? 'Generating scene cards...' : 'Reusing scene deck...', cardCounts: { requested: plan.cardJobs?.length || 0 }, chips: ['Cards'] });
    const cache = await storage.loadSceneCache(snap.chatKey, snap.sceneKey);
    const existing = cache?.cards || [];
    const generated = localCards(snap);
    const deck = applyCardPlan(existing, {
      acceptedCards: generated,
      lifecycle: generated.map((card) => ({ action: 'select', cardId: card.id, reason: 'current fallback hand' }))
    });
    await storage.saveSceneCache(snap.chatKey, snap.sceneKey, {
      cacheState: 'active',
      source: {
        chatIdHash: hashJson(snap.chatId),
        latestMesId: snap.latestMesId,
        sceneFingerprint: snap.sceneFingerprint,
        chatWindowHash: hashJson(snap.messages)
      },
      cards: deck.cards
    });
    activity.stage({ runId, phase: 'handSelected', label: 'Selecting turn hand...', cardCounts: { selected: Math.min(deck.cards.length, plan.budgets?.maxCards || 6) } });
    lastHand = selectHand(deck.cards, { maxCards: plan.budgets?.maxCards || 6, maxTokens: plan.budgets?.targetBriefTokens || 700 });
    const packet = await composePromptPacket({ hand: lastHand, snapshot: snap, settings, generationRouter, activity, runId });
    lastPacket = packet;
    if (settings.mode === 'observe') {
      activity.settle({ runId, outcome: 'success', label: 'Observe mode: hand preview ready. No prompt injected.' });
      return { ok: true, observe: true, packet };
    }
    activity.stage({ runId, phase: 'promptInstalling', label: 'Installing Recursion prompt...', chips: ['Prompt'] });
    const install = await host.prompt?.install?.(packet);
    await storage.appendJournal(snap.chatKey, { event: install?.ok === false ? 'prompt.install_failed' : 'prompt.installed', severity: install?.ok === false ? 'warn' : 'info', summary: install?.ok === false ? 'Prompt install failed' : 'Prompt installed', runId, hashes: { promptPacketHash: packet.diagnostics.packetHash } });
    activity.settle({ runId, outcome: install?.ok === false ? 'warning' : 'success', label: install?.ok === false ? 'Prompt install failed. Generation will continue without Recursion.' : 'Recursion prompt ready.' });
    activeRunId = null;
    return { ok: install?.ok !== false, packet, install };
  }

  return {
    prepareForGeneration,
    async refreshScene() {
      return prepareForGeneration({ userMessage: 'manual refresh' });
    },
    view() {
      return {
        activeRunId,
        lastPacket,
        lastHand,
        lastPlan,
        lastSnapshot,
        activity: activity.current(),
        settings: settingsStore.get(),
        updatedAt: nowIso()
      };
    }
  };
}
```

- [ ] **Step 4: Verify runtime passes**

Run:

```powershell
npm run test:runtime
```

Expected output contains:

```text
[pass] runtime
```

- [ ] **Step 5: Commit**

```powershell
git add src/runtime.mjs tools/scripts/test-runtime.mjs
git commit -m "feat: add Recursion runtime coordinator"
```

---

### Task 10: SillyTavern Host Adapter

**Files:**
- Create: `F:\git\Recursion\src\hosts\sillytavern\host.mjs`
- Create: `F:\git\Recursion\tools\scripts\test-host.mjs`

- [ ] **Step 1: Write failing host adapter tests**

Create `F:\git\Recursion\tools\scripts\test-host.mjs`:

```js
import { createSillyTavernHost, promptBlocksFromPacket } from '../../src/hosts/sillytavern/host.mjs';
import { assertEqual } from '../../tests/helpers/assert.mjs';

const prompts = [];
const context = {
  chatId: 'chat-file',
  chat: [{ mesid: 0, is_user: true, mes: 'Hello' }],
  setExtensionPrompt(key, text, position, depth, scan, role) {
    prompts.push({ key, text, position, depth, scan, role });
  },
  extension_prompt_types: { IN_CHAT: 1, IN_PROMPT: 2, BEFORE_PROMPT: 0 },
  extension_prompt_roles: { SYSTEM: 0 },
  generateRaw: async () => ({ text: '{"schema":"x"}' })
};

const host = createSillyTavernHost({ contextFactory: () => context, settingsRoot: {} });
const snap = await host.snapshot();
assertEqual(snap.chatId, 'chat-file', 'chat id read');
assertEqual(snap.messages[0].text, 'Hello', 'message text read');

const packet = {
  injectionPlan: { blocks: [{ id: 'turnBrief', promptKey: 'recursion.turnBrief', placement: 'in_chat', depth: 2, role: 'system' }] },
  sections: { turnBrief: 'Use the alley scene.', sceneBrief: '', guardrails: '' }
};
assertEqual(promptBlocksFromPacket(packet)[0].text, 'Use the alley scene.', 'prompt block text built');
await host.prompt.install(packet);
assertEqual(prompts[0].key, 'recursion.turnBrief', 'prompt installed with Recursion key');
console.log('[pass] host');
```

- [ ] **Step 2: Run the test and verify it fails because the module is missing**

Run:

```powershell
npm run test:host
```

Expected: FAIL with a module-not-found error for `src/hosts/sillytavern/host.mjs`.

- [ ] **Step 3: Implement SillyTavern host adapter**

Create `F:\git\Recursion\src\hosts\sillytavern\host.mjs`:

```js
import { hashJson, safeId } from '../../core.mjs';
import { packetToPromptBlocks } from '../../prompt.mjs';
import { createProviderClient } from '../../providers.mjs';
import { createSettingsStore } from '../../settings.mjs';
import { createMemoryStorageAdapter } from '../../storage.mjs';

function contextFromGlobal() {
  return globalThis.SillyTavern?.getContext?.() || null;
}

function promptApi(context) {
  return {
    setExtensionPrompt: context?.setExtensionPrompt || globalThis.setExtensionPrompt,
    types: context?.extension_prompt_types || globalThis.extension_prompt_types || { IN_CHAT: 1, IN_PROMPT: 2, BEFORE_PROMPT: 0 },
    roles: context?.extension_prompt_roles || globalThis.extension_prompt_roles || { SYSTEM: 0, USER: 1, ASSISTANT: 2 }
  };
}

function position(api, placement) {
  const value = String(placement || '').toLowerCase();
  if (value === 'before_prompt' || value === 'beforeprompt') return api.types.BEFORE_PROMPT ?? 0;
  if (value === 'in_prompt' || value === 'inprompt') return api.types.IN_PROMPT ?? 2;
  return api.types.IN_CHAT ?? 1;
}

function role(api, value) {
  const text = String(value || 'system').toLowerCase();
  if (text === 'user') return api.roles.USER ?? 1;
  if (text === 'assistant') return api.roles.ASSISTANT ?? 2;
  return api.roles.SYSTEM ?? 0;
}

function readChatId(context) {
  return String(context?.chatId || context?.chat_id || context?.currentChatId || context?.getCurrentChatId?.() || 'chat').trim();
}

function readMessages(context) {
  const chat = Array.isArray(context?.chat) ? context.chat : [];
  return chat.map((message, index) => ({
    mesid: Number(message.mesid ?? message.id ?? index),
    role: message.is_user ? 'user' : (message.is_system ? 'system' : 'assistant'),
    name: String(message.name || ''),
    text: String(message.mes || message.text || message.content || '')
  }));
}

export function promptBlocksFromPacket(packet) {
  return packetToPromptBlocks(packet).filter((block) => block.text.trim());
}

function createPromptAdapter(contextFactory) {
  const installed = new Set();
  async function clear() {
    const context = contextFactory();
    const api = promptApi(context);
    if (typeof api.setExtensionPrompt !== 'function') return { ok: true, skipped: true };
    for (const key of [...installed, 'recursion.sceneBrief', 'recursion.turnBrief', 'recursion.guardrails', 'recursion.rawCriticalGuardrail']) {
      api.setExtensionPrompt(key, '', api.types.IN_CHAT ?? 1, 4, false, api.roles.SYSTEM ?? 0);
      installed.delete(key);
    }
    return { ok: true };
  }
  async function install(packet) {
    const context = contextFactory();
    const api = promptApi(context);
    if (typeof api.setExtensionPrompt !== 'function') return { ok: false, error: { message: 'setExtensionPrompt unavailable' } };
    await clear();
    for (const block of promptBlocksFromPacket(packet)) {
      if (!String(block.promptKey || '').startsWith('recursion.')) throw new Error(`Refusing prompt key ${block.promptKey}`);
      api.setExtensionPrompt(block.promptKey, block.text, position(api, block.placement), Number(block.depth || 4), false, role(api, block.role));
      installed.add(block.promptKey);
    }
    return { ok: true, installed: [...installed] };
  }
  return { install, clear };
}

function createGenerationAdapter(contextFactory) {
  async function generate(request = {}) {
    const context = contextFactory();
    if (!context) throw new Error('SillyTavern context unavailable');
    const prompt = [request.systemPrompt, request.prompt].filter(Boolean).join('\n\n');
    if (typeof context.generateRaw === 'function') return context.generateRaw({ prompt, systemPrompt: request.systemPrompt, responseLength: request.maxTokens, jsonSchema: request.jsonSchema || null, signal: request.signal });
    if (typeof context.generateQuietPrompt === 'function') return { text: await context.generateQuietPrompt(prompt) };
    throw new Error('No supported SillyTavern generation method is available.');
  }
  return {
    generate,
    async batch(requests = []) {
      const results = [];
      for (const request of requests) results.push(await generate(request));
      return results;
    }
  };
}

export function createSillyTavernHost({ contextFactory = contextFromGlobal, settingsRoot = globalThis.extension_settings || {}, storageAdapter = createMemoryStorageAdapter() } = {}) {
  const settingsStore = createSettingsStore({ root: settingsRoot });
  const generation = createGenerationAdapter(contextFactory);
  return {
    id: 'sillytavern',
    settingsStore,
    storageAdapter,
    generation,
    providerClient: createProviderClient({ host: { generation }, settingsStore }),
    prompt: createPromptAdapter(contextFactory),
    async snapshot() {
      const context = contextFactory();
      const chatId = readChatId(context);
      const messages = readMessages(context);
      const latestMesId = messages.at(-1)?.mesid ?? 0;
      const recent = messages.slice(-20);
      const sceneFingerprint = hashJson(recent.map((message) => ({ role: message.role, text: message.text.slice(0, 400) })));
      return {
        chatId,
        chatKey: safeId(chatId, 'chat'),
        sceneKey: safeId(sceneFingerprint, 'scene'),
        sceneFingerprint,
        turnFingerprint: hashJson({ latestMesId, latest: messages.at(-1) || null }),
        latestMesId,
        messages
      };
    }
  };
}
```

- [ ] **Step 4: Verify host adapter passes**

Run:

```powershell
npm run test:host
```

Expected output contains:

```text
[pass] host
```

- [ ] **Step 5: Commit**

```powershell
git add src/hosts/sillytavern/host.mjs tools/scripts/test-host.mjs
git commit -m "feat: add SillyTavern host adapter"
```

---

### Task 11: Recursion Bar, Activity Ribbon, Viewer, And Styles

**Files:**
- Create: `F:\git\Recursion\src\ui.mjs`
- Create: `F:\git\Recursion\styles\recursion.css`
- Create: `F:\git\Recursion\tools\scripts\test-ui.mjs`

- [ ] **Step 1: Write failing UI tests**

Create `F:\git\Recursion\tools\scripts\test-ui.mjs`:

```js
import { activityLabel, createRecursionViewModel } from '../../src/ui.mjs';
import { assertEqual } from '../../tests/helpers/assert.mjs';

assertEqual(activityLabel({ phase: 'cardBatchRunning' }), 'Generating scene cards...', 'phase label mapped');
const model = createRecursionViewModel({
  settings: { mode: 'auto' },
  lastHand: { cards: [{ id: 'c1' }, { id: 'c2' }] },
  activity: { phase: 'settled', label: 'Recursion prompt ready.', severity: 'success' },
  lastPacket: { diagnostics: { composerLane: 'utility' } }
});
assertEqual(model.statusText, 'Ready - Auto', 'status text built');
assertEqual(model.handCount, 2, 'hand count built');
assertEqual(model.composerLabel, 'Utility', 'composer label built');
console.log('[pass] ui');
```

- [ ] **Step 2: Run the test and verify it fails because the module is missing**

Run:

```powershell
npm run test:ui
```

Expected: FAIL with a module-not-found error for `src/ui.mjs`.

- [ ] **Step 3: Implement UI module**

Create `F:\git\Recursion\src\ui.mjs`:

```js
const PHASE_LABELS = Object.freeze({
  started: 'Reading current turn...',
  arbiterPlanning: 'Planning card pass...',
  cardBatchRunning: 'Generating scene cards...',
  handSelected: 'Selecting turn hand...',
  utilityComposing: 'Composing prompt packet with Utility...',
  reasonerComposing: 'Reasoner composing final brief...',
  promptInstalling: 'Installing Recursion prompt...',
  promptPacketBuilt: 'Recursion prompt ready.',
  storageSaving: 'Saving scene cache...',
  storageComplete: 'Scene cache saved.',
  settled: 'Recursion prompt ready.'
});

export function activityLabel(activity = {}) {
  return activity.label || PHASE_LABELS[activity.phase] || 'Recursion is working...';
}

export function createRecursionViewModel(view = {}) {
  const mode = String(view.settings?.mode || 'observe');
  const handCount = Array.isArray(view.lastHand?.cards) ? view.lastHand.cards.length : 0;
  const activity = view.activity || {};
  const ready = activity.phase === 'settled' || activity.phase === 'idle';
  return {
    mode,
    statusText: `${ready ? 'Ready' : 'Working'} - ${mode[0].toUpperCase()}${mode.slice(1)}`,
    handCount,
    activityLabel: activityLabel(activity),
    activitySeverity: activity.severity || 'info',
    activityChips: activity.chips || [],
    composerLabel: view.lastPacket?.diagnostics?.composerLane === 'reasoner' ? 'Reasoner' : 'Utility',
    reasonerState: view.settings?.providers?.reasoner?.enabled ? 'available' : 'disabled'
  };
}

function button(label, className, onClick) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = className;
  el.textContent = label;
  el.addEventListener('click', onClick);
  return el;
}

function renderHandDropdown(root, view) {
  const panel = root.querySelector('[data-recursion-hand]');
  panel.replaceChildren();
  const cards = view.lastHand?.cards || [];
  const title = document.createElement('strong');
  title.textContent = `Last Hand - ${cards.length} card${cards.length === 1 ? '' : 's'} - composed by ${view.lastPacket?.diagnostics?.composerLane || 'utility'}`;
  panel.appendChild(title);
  if (!cards.length) {
    const empty = document.createElement('p');
    empty.textContent = 'No hand has been composed for this chat.';
    panel.appendChild(empty);
    return;
  }
  for (const card of cards) {
    const row = document.createElement('div');
    row.className = 'recursion-hand-row';
    row.textContent = `[${card.emphasis || 'normal'}] ${card.family}: ${card.summary || card.promptText || card.id}`;
    panel.appendChild(row);
  }
}

function renderViewer(root, view) {
  const viewer = root.querySelector('[data-recursion-viewer]');
  viewer.replaceChildren();
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify({
    activity: view.activity,
    lastHand: view.lastHand,
    lastPacket: view.lastPacket,
    settings: view.settings
  }, null, 2);
  viewer.appendChild(pre);
}

export function mountRecursionUi({ runtime, mountPoint = null } = {}) {
  if (typeof document === 'undefined') return { update() {}, destroy() {} };
  const root = document.createElement('section');
  root.id = 'recursion-root';
  root.className = 'recursion-root';
  root.innerHTML = `
    <div class="recursion-bar" role="toolbar" aria-label="Recursion">
      <strong class="recursion-brand">Recursion</strong>
      <span class="recursion-status" data-recursion-status></span>
      <span class="recursion-chip" data-recursion-hand-count></span>
      <span class="recursion-chip" data-recursion-composer></span>
      <button type="button" data-recursion-actions>Actions</button>
      <button type="button" data-recursion-hand-toggle>Hand</button>
      <button type="button" data-recursion-viewer-toggle>Open</button>
    </div>
    <div class="recursion-ribbon" role="status" aria-live="polite" data-recursion-ribbon hidden>
      <span class="recursion-pulse" aria-hidden="true"></span>
      <span data-recursion-ribbon-label></span>
      <span class="recursion-ribbon-chips" data-recursion-ribbon-chips></span>
    </div>
    <div class="recursion-dropdown" data-recursion-hand hidden></div>
    <dialog class="recursion-viewer" data-recursion-viewer><button type="button" data-recursion-viewer-close>Close</button></dialog>
  `;

  const parent = mountPoint || document.getElementById('chat')?.parentElement || document.body;
  parent.insertBefore(root, document.getElementById('chat') || parent.firstChild);

  root.querySelector('[data-recursion-actions]').addEventListener('click', () => runtime.refreshScene?.());
  root.querySelector('[data-recursion-hand-toggle]').addEventListener('click', () => {
    const panel = root.querySelector('[data-recursion-hand]');
    panel.hidden = !panel.hidden;
  });
  root.querySelector('[data-recursion-viewer-toggle]').addEventListener('click', () => root.querySelector('[data-recursion-viewer]').showModal?.());
  root.querySelector('[data-recursion-viewer-close]').addEventListener('click', () => root.querySelector('[data-recursion-viewer]').close?.());

  function update() {
    const view = runtime.view();
    const model = createRecursionViewModel(view);
    root.querySelector('[data-recursion-status]').textContent = model.statusText;
    root.querySelector('[data-recursion-hand-count]').textContent = `Hand ${model.handCount}`;
    root.querySelector('[data-recursion-composer]').textContent = model.composerLabel;
    const ribbon = root.querySelector('[data-recursion-ribbon]');
    ribbon.hidden = ['idle'].includes(view.activity?.phase);
    ribbon.dataset.recursionSeverity = model.activitySeverity;
    root.querySelector('[data-recursion-ribbon-label]').textContent = model.activityLabel;
    root.querySelector('[data-recursion-ribbon-chips]').textContent = model.activityChips.join(' - ');
    renderHandDropdown(root, view);
    renderViewer(root, view);
  }

  update();
  const interval = setInterval(update, 500);
  return {
    update,
    destroy() {
      clearInterval(interval);
      root.remove();
    }
  };
}
```

Create `F:\git\Recursion\styles\recursion.css`:

```css
.recursion-root {
  color: var(--SmartThemeBodyColor, #d8d8d8);
  font-family: inherit;
  border-bottom: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, #555) 70%, transparent);
  background: color-mix(in srgb, var(--SmartThemeBlurTintColor, #1f1f1f) 88%, #111);
  z-index: 20;
}

.recursion-bar {
  min-height: 30px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 8px;
  font-size: 13px;
}

.recursion-brand {
  color: var(--SmartThemeQuoteColor, #8dd8e8);
  font-weight: 700;
}

.recursion-status,
.recursion-chip,
.recursion-bar button {
  border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, #555) 80%, transparent);
  border-radius: 6px;
  padding: 2px 7px;
  background: color-mix(in srgb, var(--SmartThemeBlurTintColor, #222) 70%, #000);
  color: inherit;
}

.recursion-bar button {
  cursor: pointer;
}

.recursion-ribbon {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  padding: 3px 8px 6px;
  border-top: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, #555) 50%, transparent);
  animation: recursion-slide 160ms ease-out;
}

.recursion-ribbon[data-recursion-severity="warning"] {
  color: #ffd479;
}

.recursion-ribbon[data-recursion-severity="error"] {
  color: #ff8a8a;
}

.recursion-pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #70d7ef;
  box-shadow: 0 0 0 0 rgba(112, 215, 239, 0.7);
  animation: recursion-pulse 1.2s infinite;
}

.recursion-ribbon-chips {
  opacity: 0.75;
  font-size: 12px;
}

.recursion-dropdown {
  padding: 8px;
  border-top: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, #555) 55%, transparent);
}

.recursion-hand-row {
  padding: 4px 0;
  border-top: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, #555) 35%, transparent);
}

.recursion-viewer {
  max-width: min(900px, 92vw);
  max-height: 85vh;
  color: var(--SmartThemeBodyColor, #ddd);
  background: var(--SmartThemeBlurTintColor, #202020);
  border: 1px solid var(--SmartThemeBorderColor, #555);
  border-radius: 8px;
}

.recursion-viewer pre {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
}

@keyframes recursion-slide {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes recursion-pulse {
  0% { box-shadow: 0 0 0 0 rgba(112, 215, 239, 0.7); }
  70% { box-shadow: 0 0 0 7px rgba(112, 215, 239, 0); }
  100% { box-shadow: 0 0 0 0 rgba(112, 215, 239, 0); }
}

@media (max-width: 720px) {
  .recursion-bar {
    flex-wrap: wrap;
  }
}
```

- [ ] **Step 4: Verify UI passes**

Run:

```powershell
npm run test:ui
```

Expected output contains:

```text
[pass] ui
```

- [ ] **Step 5: Commit**

```powershell
git add src/ui.mjs styles/recursion.css tools/scripts/test-ui.mjs
git commit -m "feat: add Recursion bar and activity ribbon UI"
```

---

### Task 12: Extension Entrypoint And Generation Interceptor

**Files:**
- Create: `F:\git\Recursion\src\extension\index.js`
- Create: `F:\git\Recursion\tools\scripts\test-extension-smoke.mjs`

- [ ] **Step 1: Write failing extension smoke test**

Create `F:\git\Recursion\tools\scripts\test-extension-smoke.mjs`:

```js
import '../../src/extension/index.js';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

assert(typeof globalThis.recursionGenerationInterceptor === 'function', 'generation interceptor exported globally');
assert(typeof globalThis.recursionOnEnable === 'function', 'enable hook exported globally');
const result = await globalThis.recursionGenerationInterceptor('hello');
assertEqual(result, 'hello', 'interceptor returns original chat payload when no host is available');
console.log('[pass] extension smoke');
```

The Task 1 runner already imports every `test-*.mjs` script, so `F:\git\Recursion\tools\scripts\run-tests.mjs` needs no change in this task.

- [ ] **Step 2: Run the smoke test and verify it fails because the entrypoint is missing**

Run:

```powershell
node tools/scripts/test-extension-smoke.mjs
```

Expected: FAIL with a module-not-found error for `src/extension/index.js`.

- [ ] **Step 3: Implement the extension entrypoint**

Create `F:\git\Recursion\src\extension\index.js`:

```js
import { createSillyTavernHost } from '../hosts/sillytavern/host.mjs';
import { createGenerationRouter } from '../providers.mjs';
import { createRecursionRuntime } from '../runtime.mjs';
import { createStorageRepository } from '../storage.mjs';
import { mountRecursionUi } from '../ui.mjs';
import { createActivityReporter } from '../activity.mjs';

let runtime = null;
let ui = null;

function canUseSillyTavern() {
  return Boolean(globalThis.SillyTavern?.getContext);
}

function buildRuntime() {
  if (!canUseSillyTavern()) return null;
  const host = createSillyTavernHost();
  const activity = createActivityReporter({
    onEvent: (event) => {
      const view = runtime?.view?.();
      if (view?.lastSnapshot?.chatKey) {
        runtime?.storage?.appendJournal?.(view.lastSnapshot.chatKey, { event: 'activity.stage_changed', summary: event.label, details: event });
      }
    }
  });
  const storage = createStorageRepository({ storage: host.storageAdapter, activity });
  const generationRouter = createGenerationRouter({ client: host.providerClient, activity });
  return createRecursionRuntime({ host, settingsStore: host.settingsStore, storage, activity, generationRouter });
}

export async function bootstrapRecursion() {
  if (runtime) return runtime;
  runtime = buildRuntime();
  if (runtime) ui = mountRecursionUi({ runtime });
  return runtime;
}

export async function recursionGenerationInterceptor(chat) {
  if (!runtime) await bootstrapRecursion();
  if (!runtime) return chat;
  try {
    await runtime.prepareForGeneration({ userMessage: '' });
  } catch (error) {
    console.warn('[Recursion] prepareForGeneration failed:', error);
  }
  return chat;
}

export async function recursionOnInstall() {
  return true;
}

export async function recursionOnUpdate() {
  return true;
}

export async function recursionOnEnable() {
  await bootstrapRecursion();
  return true;
}

export async function recursionOnDisable() {
  ui?.destroy?.();
  ui = null;
  await runtime?.prepareForGeneration?.({ userMessage: '' });
  runtime = null;
  return true;
}

export async function recursionOnDelete() {
  ui?.destroy?.();
  runtime = null;
  return true;
}

export async function recursionOnClean() {
  return true;
}

export async function recursionOnActivate() {
  await bootstrapRecursion();
  return true;
}

function onDocumentReady(handler) {
  if (typeof document === 'undefined') return;
  if (typeof globalThis.$ === 'function') {
    globalThis.$(document).ready(handler);
    return;
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', handler, { once: true });
    return;
  }
  handler();
}

globalThis.recursionGenerationInterceptor = recursionGenerationInterceptor;
globalThis.recursionOnInstall = recursionOnInstall;
globalThis.recursionOnUpdate = recursionOnUpdate;
globalThis.recursionOnEnable = recursionOnEnable;
globalThis.recursionOnDisable = recursionOnDisable;
globalThis.recursionOnDelete = recursionOnDelete;
globalThis.recursionOnClean = recursionOnClean;
globalThis.recursionOnActivate = recursionOnActivate;

onDocumentReady(() => {
  bootstrapRecursion().catch((error) => console.warn('[Recursion] bootstrap failed:', error));
});
```

- [ ] **Step 4: Fix runtime storage exposure used by entrypoint**

Modify `F:\git\Recursion\src\runtime.mjs`. In the returned object from `createRecursionRuntime`, add `storage` before `prepareForGeneration`:

```js
  return {
    storage,
    prepareForGeneration,
    async refreshScene() {
```

The surrounding return block should become:

```js
  return {
    storage,
    prepareForGeneration,
    async refreshScene() {
      return prepareForGeneration({ userMessage: 'manual refresh' });
    },
    view() {
      return {
        activeRunId,
        lastPacket,
        lastHand,
        lastPlan,
        lastSnapshot,
        activity: activity.current(),
        settings: settingsStore.get(),
        updatedAt: nowIso()
      };
    }
  };
```

- [ ] **Step 5: Verify extension smoke and full tests**

Run:

```powershell
node tools/scripts/test-extension-smoke.mjs
npm.cmd test
```

Expected output contains:

```text
[pass] extension smoke
[pass] test-extension-smoke.mjs
```

and all earlier test scripts pass.

- [ ] **Step 6: Commit**

```powershell
git add src/extension/index.js src/runtime.mjs tools/scripts/test-extension-smoke.mjs
git commit -m "feat: wire Recursion SillyTavern entrypoint"
```

---

### Task 13: User Guide And Live Smoke Checklist

**Files:**
- Create: `F:\git\Recursion\docs\user\RECURSION_OPERATOR_MANUAL.md`
- Modify: `F:\git\Recursion\docs\user\README.md`

- [ ] **Step 1: Add the operator manual**

Create `F:\git\Recursion\docs\user\RECURSION_OPERATOR_MANUAL.md`:

```markdown
# Recursion Operator Manual

Recursion is a mostly automatic SillyTavern extension that compiles current-scene writing context into a compact prompt packet before generation.

## Normal Use

1. Enable Recursion in SillyTavern extensions.
2. Set mode to `Observe` for inspection-only behavior or `Auto` for prompt injection.
3. Configure the Utility provider.
4. Optionally configure the Reasoner provider.
5. Send a message in chat.
6. Watch the Recursion Activity Ribbon below the Recursion Bar.

## Provider Defaults

- Utility is required and is the default composer.
- Reasoner is optional and only assists when enabled and useful.
- OpenAI-compatible API keys are session-only and are not saved.

## Activity Ribbon

The Activity Ribbon shows invisible work:

- reading current turn;
- planning card pass;
- generating cards;
- composing prompt packet;
- installing prompt;
- storage progress;
- provider fallbacks.

Warnings can persist until dismissed or superseded. Raw prompts and provider responses are not shown.

## Expected Fail-Soft Behavior

If Utility fails, Recursion skips new work or uses a valid cached hand. If Reasoner fails, Utility composition is used. If prompt install fails, SillyTavern generation continues without Recursion guidance.

## Live Smoke Checklist

1. Load SillyTavern with Recursion installed.
2. Confirm the Recursion Bar appears below other chat top bars when possible.
3. Switch mode to `Observe`.
4. Send a chat message.
5. Confirm Activity Ribbon shows work and then says no prompt was injected.
6. Switch mode to `Auto`.
7. Send a chat message.
8. Confirm Activity Ribbon reaches `Recursion prompt ready.`
9. Open the Hand dropdown and confirm compact cards are visible.
10. Open the viewer and confirm Activity, Deck, Prompt Packet, Settings, and Providers are visible.
11. Disable Reasoner and confirm Utility remains the composer.
12. Misconfigure Reasoner and confirm Utility fallback is visible.
13. Disable Recursion and confirm prompt lanes are cleared or skipped.
```

- [ ] **Step 2: Link the guide**

Replace `F:\git\Recursion\docs\user\README.md` with:

```markdown
# User Guides

- Recursion Operator Manual - RECURSION_OPERATOR_MANUAL.md
```

- [ ] **Step 3: Verify docs and tests**

Run:

```powershell
npm.cmd test
rg -n "T[O]DO|T[B]D|raw provider responses are not shown" docs src tools
```

Expected:

- `npm.cmd test` passes.
- `rg` prints the expected guide line for `raw provider responses are not shown`.
- `rg` does not print placeholder markers.

- [ ] **Step 4: Commit**

```powershell
git add docs/user/RECURSION_OPERATOR_MANUAL.md docs/user/README.md
git commit -m "docs: add Recursion operator manual"
```

---

## Final Verification

- [ ] **Run all deterministic tests**

```powershell
npm.cmd test
```

Expected output includes every script as `[pass]` and ends with a total pass line.

- [ ] **Check repository hygiene**

```powershell
git status --short
git diff --check
rg -n "T[O]DO|T[B]D|console\\.log\\(|apiKey.*settings|raw provider prompts|raw provider responses" src tools docs
```

Expected:

- `git status --short` shows only intended uncommitted work before final commit, or no output after commits.
- `git diff --check` reports no whitespace errors.
- `rg` finds no placeholder markers.
- `rg` only finds raw prompt/response wording in docs that explicitly says raw capture is disabled.
- `console.log` appears only in test scripts.

- [ ] **Manual SillyTavern smoke**

Use a dedicated SillyTavern test user such as `recursion-soak-a`. Copy or symlink the repo into that user's extension folder, for example `F:\SillyTavern\SillyTavern\data\recursion-soak-a\extensions\Recursion`, then restart or reload SillyTavern.

Do not use `default-user` for development verification, scripted smoke checks, or artifact-producing evidence. Automated harnesses must reject `default-user`, default-profile aliases, empty handles, and non-`recursion-soak-*` handles before login, navigation, storage probes, chat mutation, prompt injection, or provider calls.

Expected:

- Extension loads without console errors.
- Recursion Bar appears near the chat surface.
- Activity Ribbon appears on send/generation work.
- Observe mode does not install prompt entries.
- Auto mode installs Recursion prompt entries.
- Reasoner failure visibly falls back to Utility.
- Disabling Recursion removes or clears Recursion prompt influence.

## Self-Review Notes

- Spec coverage: tasks cover manifest, settings, provider lanes, session secrets, storage, activity ribbon events, full V1 card catalog, prompt composition, Utility/Reasoner composer paths, runtime loop, SillyTavern adapter, UI, styling, tests, and user guide.
- Placeholder scan: this plan avoids placeholder language in code and tasks.
- Type consistency: settings use lanes `utility` and `reasoner`; provider roles use the same lanes; runtime and UI consume the same `view()` shape; prompt packets use `sceneBrief`, `turnBrief`, and `guardrails` throughout.
