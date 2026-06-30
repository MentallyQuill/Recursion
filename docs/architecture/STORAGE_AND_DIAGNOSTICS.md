# Storage and Diagnostics Spec

Recursion storage exists to make the current-scene prompt compiler fast, inspectable, and recoverable. It is not a campaign save system, memory system, transcript archive, or lore database.

Related specs:

- [Product Scope](../design/RECURSION_PRODUCT_SCOPE.md)
- [Card System Spec](../design/CARD_SYSTEM_SPEC.md)
- [Runtime Architecture](RUNTIME_ARCHITECTURE.md)
- [Provider and Generation Spec](PROVIDER_AND_GENERATION_SPEC.md)
- [Prompt Composition Spec](PROMPT_COMPOSITION_SPEC.md)
- [UI Spec](../design/UI_SPEC.md)
- [Implementation Plan](../testing/IMPLEMENTATION_PLAN.md)

## Storage Philosophy

Recursion stores the minimum structured state needed to reuse current-scene work safely:

- user-facing controls and provider preferences;
- bounded scene cache records;
- source references and hashes needed to detect drift;
- sanitized recent run diagnostics;
- optional user-triggered debug exports.

The design lesson from Directive applies here in smaller form: settings are the compact control plane, while larger structured records go through logical JSON storage and a repository boundary. Runtime, UI, provider, and prompt modules should not write ad hoc files or rely on physical filenames directly. They should call storage repository APIs that own key construction, schema validation, redaction, repair, and pruning.

Every persisted record is cache-oriented. If it is stale, corrupt, too large, or tied to an obsolete schema, Recursion may discard or regenerate it. Pre-alpha status means the extension can update storage in place and invalidate old experimental records rather than carrying legacy compatibility layers.

## Settings vs Files

`extension_settings.recursion` is for compact controls only. It may store:

- enabled mode: off, observe, or auto;
- strength, prompt footprint, focus, and Reasoner-use settings;
- provider lane preferences without secrets;
- advanced routing choices when exposed;
- diagnostic toggles such as journal size or debug-export detail;
- UI preferences that are truly user settings.

It must not store scene decks, full cards, run journals, raw prompt packets, provider responses, transcript archives, or API keys. Direct endpoint API keys are session-only and must never be written to settings, cache records, journals, prompt packets, debug exports, or logs.

Logical JSON files are for bounded structured records that are larger than settings:

- `recursion-system-index.v1.json`
- `recursion-scene-{chatKey}-{sceneKey}.v1.json`
- `recursion-run-journal-{chatKey}.v1.json`
- optional user-triggered debug export records or downloads

The storage repository is the only layer that should construct those keys. `chatKey` and `sceneKey` must be normalized, path-safe identifiers, preferably derived from stable host ids plus hashes rather than raw chat titles or private story text.

## Logical Key Map

| Logical key | Owner | Purpose | Retention |
| --- | --- | --- | --- |
| `extension_settings.recursion` | SillyTavern extension settings | Compact control plane for modes, broad behavior, provider preferences, UI settings, and diagnostic toggles. | Durable until the user changes settings or resets the extension. |
| `recursion-system-index.v1.json` | Recursion storage repository | Index of known scene caches and journals, active schema/catalog versions, record sizes, last update times, and repair status. | Durable but rebuildable. If missing, rebuild from logical records. |
| `recursion-scene-{chatKey}-{sceneKey}.v1.json` | Recursion storage repository | Bounded scene deck, prompt-plan metadata, source refs/hashes, validation status, and last hand metadata for one chat scene. | Cache. Keep only recent active scenes per chat and prune aggressively. |
| `recursion-run-journal-{chatKey}.v1.json` | Recursion storage repository | Bounded ring buffer of sanitized runtime, provider, cache, invalidation, and prompt-install events for one chat. | Cache/diagnostic. Prune by count and age. |
| Optional debug export | UI action through repository | Sanitized snapshot of settings, index summary, selected scene cache metadata, and recent journal events for troubleshooting. | User-triggered only. Not written automatically during normal play. |

All records should include:

- `recordType`;
- `schemaVersion`;
- `createdAt` and `updatedAt`;
- `recursionVersion` when available;
- `chatKey` when chat-scoped;
- `schemaHash` or contract version metadata when relevant.

## Scene Cache Contract

Scene cache records hold disposable scene-local card state. Cards are cache artifacts, not durable memories. A scene cache may be deleted at any time and rebuilt from the active chat snapshot and Utility Arbiter outputs.

Recommended shape:

```ts
type RecursionSceneCacheRecord = {
  recordType: "recursion.sceneCache";
  schemaVersion: 1;
  chatKey: string;
  sceneKey: string;
  createdAt: string;
  updatedAt: string;
  cacheState: "active" | "stale" | "retired" | "invalid";
  versions: {
    cardCatalogVersion: string;
    promptCompositionVersion: string;
    providerContractVersion: string;
    settingsHash: string;
  };
  source: {
    chatIdHash: string;
    firstMesId: number;
    lastMesId: number;
    latestMesId: number;
    sceneFingerprint: string;
    chatWindowHash: string;
    sourceRefs: RecursionSourceRef[];
  };
  promptPlan?: {
    planId: string;
    generatedAt: string;
    detailProfile: "compact" | "standard" | "expanded";
    tokenBudget: number;
    planHash: string;
  };
  cards: RecursionCachedCard[];
  latestHand?: {
    handId: string;
    composedAt: string;
    cardIds: string[];
    promptPacketHash: string;
    omitted: Array<{ cardId: string; reason: string }>;
  };
  invalidation?: {
    reason: string;
    detectedAt: string;
    details?: Record<string, string | number | boolean>;
  };
};

type RecursionSourceRef = {
  refId: string;
  firstMesId: number;
  lastMesId: number;
  textHash: string;
  role?: "user" | "assistant" | "system" | "unknown";
  excerpt?: string;
};

type RecursionCachedCard = {
  id: string;
  family: string;
  status: "candidate" | "active" | "stowed" | "stale" | "discarded";
  summary: string;
  promptText: string;
  evidenceRefs: string[];
  tokenEstimate: number;
  emphasis: "normal" | "emphasized" | "muted";
  generatedAt: string;
  sourceFingerprint: string;
  arbiterDecisionHash?: string;
  inspectorNotes?: string;
};
```

Contract rules:

- `promptText` is injectable card text, but it is still cache data and must remain compact.
- `summary` supports UI scanning and diagnostics; it is not a second prompt body.
- `inspectorNotes` are diagnostic-only and must never enter prompt composition or injected prompt logs.
- `sourceRefs` point to host message ids and hashes. They must not duplicate the transcript.
- `excerpt` is optional, disabled by default for normal journals, and always bounded when present. Use excerpts only when they materially improve user-visible inspection or debug exports.
- Scene cache records must reject or truncate over-large cards before write.
- A scene cache cannot be promoted into cross-scene memory. A new scene gets a new cache.

## Run Journal Contract

Run journals explain recent behavior without storing private model I/O. They are bounded ring buffers, not append-only archives.

Recommended shape:

```ts
type RecursionRunJournalRecord = {
  recordType: "recursion.runJournal";
  schemaVersion: 1;
  chatKey: string;
  createdAt: string;
  updatedAt: string;
  maxEntries: number;
  nextIndex: number;
  entries: RecursionRunJournalEntry[];
};

type RecursionRunJournalEntry = {
  id: string;
  recordedAt: string;
  runId?: string;
  sceneKey?: string;
  event:
    | "runtime.started"
    | "runtime.stopped"
    | "activity.stage_changed"
    | "activity.settled"
    | "cache.hit"
    | "cache.miss"
    | "cache.invalidated"
    | "card.generated"
    | "card.rejected"
    | "hand.selected"
    | "prompt.installed"
    | "prompt.cleared"
    | "provider.call.started"
    | "provider.call.completed"
    | "provider.call.failed"
    | "storage.repaired"
    | "storage.pruned";
  severity: "debug" | "info" | "warn" | "error";
  summary: string;
  details?: Record<string, string | number | boolean | null>;
  hashes?: {
    requestHash?: string;
    responseHash?: string;
    promptPacketHash?: string;
    sourceHash?: string;
  };
  metrics?: {
    durationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    cardCount?: number;
    omittedCount?: number;
  };
};
```

Journal entries may record provider name, resolved model, status code, error category, timing, token counts, schema-validity result, request hash, response hash, prompt packet hash, selected card ids, omission reasons, and invalidation reasons.

Journal entries must not record:

- API keys, authorization headers, cookies, or session tokens;
- raw prompts sent to providers;
- raw provider responses;
- hidden chain-of-thought or private reasoning;
- full chat transcript text;
- unbounded excerpts;
- private diagnostic notes in any injected prompt log.

Default `maxEntries` should be small enough that the journal stays cheap to load. V1 should start around 100 events per chat unless tests show that a smaller cap is enough for the UI and debugging workflow.

## Activity Event Contract

Activity events are the sanitized source for the Recursion Bar, Activity Ribbon, and Full Viewer activity surface. They are not raw logs. They translate runtime/provider/storage events into compact user-facing stages.

Recommended activity details:

- `runId`;
- `phase`;
- `mode`: foreground, background, or review;
- `severity`;
- visible `label`;
- compact `detail`;
- status `chips`;
- provider lane and composer lane;
- card counts;
- fallback path when one was used.

Activity events may be written to the bounded run journal when useful for recent-run inspection. They should be compact enough to render without reading raw provider payloads or large cache records.

Activity events must not include:

- raw provider prompts;
- raw provider responses;
- full prompt packets;
- full transcript text;
- API keys, headers, cookies, or session secrets;
- physical file paths when a logical storage key is enough;
- hidden reasoning or private story plans.

The Activity Ribbon should prefer the latest active run state over a chronological dump. The Full Viewer may show a bounded timeline derived from the same activity events.

## Diagnostics and Redaction

Diagnostics should prove what Recursion did without leaking sensitive material. The default diagnostic mode is sanitized metadata only.

Allowed by default:

- schema versions and contract versions;
- provider lane id, provider source type, and resolved model name;
- status codes and normalized error categories;
- runtime durations and token counts;
- card ids, families, statuses, and token estimates;
- source message id ranges and text hashes;
- prompt packet hashes and omission reasons;
- cache hit, miss, stale, repair, and prune events.

Forbidden by default:

- API keys and other credentials;
- raw provider prompts and responses;
- raw SillyTavern transcript archives;
- complete character cards, World Info entries, Memory Book entries, or other extension-owned context;
- hidden chain-of-thought;
- private story plans;
- inspector-only notes copied into prompt logs;
- filesystem paths that expose private usernames when a logical key is enough.

Redaction must be centralized in the storage/diagnostics layer. It should recursively remove or replace fields with sensitive key names such as `apiKey`, `authorization`, `cookie`, `token`, `password`, `secret`, and `sessionKey`. It should cap all strings in diagnostic exports, even when the field is otherwise allowed.

Bounded excerpts are opt-in and should be treated as more sensitive than hashes. If enabled, they must be short, source-labeled, and never used as a substitute for transcript storage. Debug exports should clearly mark whether excerpts are included.

Raw provider prompts and raw provider responses are disabled by default for normal diagnostics and debug exports. Any future raw-capture mode would require an explicit separate product decision, clear UI warning, redaction gates, short retention, and must never capture API keys or hidden reasoning.

## Invalidation Rules

Recursion should invalidate aggressively. Rebuilding a scene cache is cheaper and safer than injecting stale guidance.

Hard invalidation retires or deletes the current scene cache:

- active chat changes;
- `chatKey` no longer matches the host chat;
- scene fingerprint changes sharply;
- active cast, location, or immediate situation shifts enough to define a new scene;
- source message edits or deletions break a stored source range;
- source hashes fail to match current host messages;
- schema version, card catalog version, provider contract version, or prompt composition contract changes;
- stored record fails schema validation;
- storage repair marks a record corrupt or unsafe.

Soft invalidation marks the cache stale and asks the Utility Arbiter to review:

- user requests Refresh Scene or Regenerate Next Brief;
- provider settings, model, route, strength, focus, prompt footprint, or Reasoner mode changes;
- freshness cap is reached;
- source window advances beyond the card evidence range;
- token budget changes materially;
- the Arbiter reports missing, duplicate, or low-quality catalog coverage;
- runtime rejects a card for size, schema, or safety reasons.

The repository should record the invalidation reason in the scene cache when the record remains readable, and in the run journal when the scene cache is removed. In pre-alpha, compatibility migrations should be rare. Prefer schema bumps, invalidation, and rebuilds unless a tiny in-place rewrite is clearly safer.

## Cleanup/Repair

Storage repair runs at startup, manual repair, and before debug export. It should be conservative about user data and aggressive about Recursion cache data.

Repair responsibilities:

- rebuild `recursion-system-index.v1.json` if it is missing or stale;
- remove index entries for missing records;
- add index entries for valid orphaned Recursion records;
- mark corrupt records invalid and exclude them from runtime use;
- prune scene caches beyond the configured per-chat and total caps;
- prune run journals beyond count and age caps;
- remove records with unsupported schema versions during pre-alpha resets;
- report repair actions through sanitized journal events and UI status.

V1 retention should start small:

- keep the active scene cache;
- keep a small number of recently retired scene caches per chat for inspection;
- keep one bounded run journal per chat;
- prune discarded-card history unless diagnostics explicitly need it.

Cleanup must never delete SillyTavern chats, character data, World Info, Memory Books, Summaryception data, VectFox data, or any non-Recursion extension records.

## Storage Progress UX

Storage progress is user-facing only as logical stage feedback. The UI should not mirror physical file writes, repeated uploads, raw key churn, or internal retry noise.

Recommended logical stages:

- `Loading Recursion settings`
- `Opening scene cache`
- `Updating scene cache`
- `Writing run journal`
- `Repairing storage index`
- `Cleaning old cache`
- `Storage ready`

The normal auto path should stay quiet unless storage is slow, blocked, or manually invoked. Manual actions such as Refresh Scene, Clear Scene Cache, Clear Run Journal, Repair Storage, and Export Diagnostics should show concise progress in the Recursion bar or viewer activity surface.

Progress events should include a stable operation id, logical stage, severity, and optional sanitized counts. They should not expose physical paths or full JSON payloads. Storage progress should be separate from provider generation progress so that a model cancellation does not make a completed cache write look like a failed generation.

## Tests

Storage and diagnostics tests should be deterministic and should not require a live SillyTavern host unless the implementation plan explicitly marks a smoke test as live.

Required coverage:

- settings persistence stores compact controls and excludes session API keys;
- logical key builders sanitize `chatKey` and `sceneKey`;
- scene cache schema accepts valid records and rejects missing version, oversized card text, invalid statuses, and unsafe source refs;
- scene cache writes store source refs/hashes and bounded excerpts only, not full transcript archives;
- run journal enforces ring-buffer bounds;
- journal redaction strips secrets, raw prompts, raw responses, headers, cookies, and private notes;
- debug export uses the same redaction path as normal diagnostics;
- invalidation matrix covers chat change, scene shift, message edit/delete, provider/settings changes, schema changes, card catalog changes, and prompt composition contract changes;
- cleanup rebuilds a missing index, ignores corrupt records, prunes old caches, and never touches non-Recursion records;
- storage progress aggregates logical stages instead of reporting each physical file write;
- prompt-install logs include hashes and card ids, not private diagnostic notes or raw prompt bodies by default.

The broader build order and verification gates belong in [Implementation Plan](../testing/IMPLEMENTATION_PLAN.md).

## Explicit Non-Goals

Recursion storage must not become:

- a campaign save system;
- a save branching system;
- a durable memory or lore database;
- a transcript archive;
- a vector store or embedding-recall layer;
- a replacement for World Info, Memory Books, Summaryception, VectFox, or similar extensions;
- a user-authored card catalog;
- a card marketplace or plugin registry;
- a hidden chain-of-thought store;
- a private plot-planning store;
- a raw provider request/response log;
- a file browser for SillyTavern data;
- a compatibility museum for pre-alpha cache formats.

If a future feature needs durable story memory, cross-scene canon, import/export of authored lore, or transcript-scale recall, it belongs in a separate product decision and probably a separate storage boundary. Recursion V1 should remain a minimal, structured, cache-oriented prompt compiler.
