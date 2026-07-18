# Recursion Prepared Generation Swipe Reuse Design

## Status

**Draft for review.** The architectural direction is approved: when a
latest-assistant swipe has the same pre-assistant generation basis, Recursion
reuses the complete prepared Prompt Packet and selected hand instead of calling
the Arbiter or any other recursive provider again.

This design hardens the existing `lastPacket` / `lastHand` fast path. It does
not introduce a separate Arbiter-response cache.

For latest-assistant same-turn packet reuse, this document supersedes the
earlier direction in
`docs/superpowers/specs/2026-07-02-recursion-swipe-support-improvement-design.md`.
That earlier design remains relevant to older-message swipe-aware source
fingerprints and bounded scene-cache variants.

## Product Decision

For a latest-assistant swipe, the assistant response being replaced is output,
not input. If everything that produced the original Recursion prompt is still
the same, Recursion should reinstall that exact prompt immediately and let
SillyTavern request a new story-model response.

```text
Same pre-assistant source + same packet-producing configuration
    -> reuse prepared Prompt Packet + hand
    -> zero Recursion provider calls
    -> SillyTavern still generates a new assistant response
```

The reusable unit is one atomic **Prepared Generation Artifact**:

```text
Prompt Packet + selected hand + generation basis + packet-input contract
```

Recursion accepts or rejects the artifact as a whole. It never combines an old
packet with a newly reconstructed hand or an old hand with a newly composed
packet.

## Why This Is the Right Cache Boundary

The Utility Arbiter is only one stage in the recursive preparation pipeline.
Caching its answer would still leave card generation, hand selection, Guidance
composition, optional Reasoner composition, and Prompt Packet assembly.

Reusing the completed artifact skips all of those stages:

- Utility Arbiter;
- Standard card calls;
- Fused card bundle;
- Rapid warm/foreground work for that same prepared turn;
- Guidance Composer;
- optional Reasoner Composer;
- hand selection;
- Prompt Packet composition.

The story model is not cached. SillyTavern still performs a new generation, so
temperature, sampling, and provider nondeterminism can produce a different
assistant response from the same Recursion guidance.

## Current Runtime Baseline

Recursion already has most of the fast path:

- `sameSourceBeforeLatestAssistant(...)` removes the active assistant and
  compares the preceding bounded source;
- `reusableSnapshotForLatestAssistantSwipeRetry(...)` recognizes an eligible
  latest-assistant swipe;
- `canReuseLastPacketForSnapshot(...)` validates basic packet/snapshot
  identity;
- `reinstallLastPacketForSameTurn(...)` reinstalls `lastPacket` and reports a
  `swipe-packet` cache hit;
- Standard, Rapid, and Fused deterministic tests prove ordinary same-turn
  swipe reuse can make zero additional provider calls;
- Force Fresh and explicit Regenerate bypass the fast path;
- latest-assistant `MESSAGE_SWIPED` events are classified separately from
  older-message source mutations.

The existing path is not yet a complete cache contract:

1. `lastPacket` and `lastHand` have separate mutable ownership.
2. The hot-path check does not compare packet-affecting settings, provider
   configuration, active deck contents, or contract versions.
3. Reinstallation does not perform the normal final host-snapshot recheck
   immediately before `installPrompt(...)`.
4. stopped-swipe preservation writes `recordedAt` but not the `recordedAtMs`
   read by the current retry-age check.
5. the two-minute retry age is being used as validity even though source and
   contract identity are the actual validity conditions.
6. current host-stop tests preserve the packet and hand but do not complete a
   stop -> swipe -> zero-provider-call regression.

## Goals

- Make an unchanged latest-assistant swipe effectively instant from
  Recursion's perspective.
- Skip every Recursion provider call on an exact Prepared Generation hit.
- Define one explicit, inspectable generation-basis identity.
- Define one narrowly scoped packet-input contract.
- Make packet and hand ownership atomic.
- Preserve a last-known-good artifact across a stopped swipe.
- Reject stale work after source, deck, provider, policy, or prompt-contract
  changes.
- Re-read the host immediately before reinstalling a cached packet.
- Keep cache diagnostics compact and free of raw transcript or secret data.
- Prove the exact SillyTavern swipe path, not only direct runtime calls.

## Non-Goals

- Persisting complete Prompt Packets across page reloads.
- Caching arbitrary provider responses.
- Caching the Utility Arbiter as an independent V1 feature.
- Reusing a packet after a new user turn.
- Treating older-message A/B/A navigation as a same-turn packet hit. Existing
  bounded scene-cache variants remain responsible for older source variants.
- Making transient provider health part of packet validity.
- Adding user-facing cache controls or new visible UI.
- Changing Generation Review or Enhancement deduplication.
- Preserving compatibility with old pre-alpha volatile state shapes.

## Terminology

### Generation basis

The normalized bounded source that requested the assistant response. For an
ordinary generation, this is the prompt snapshot used to compose the packet.
For a latest-assistant swipe, it is the current snapshot after removing the
latest assistant output being replaced.

### Output target

The current latest assistant message that SillyTavern is replacing. Its
message ID is used to classify and guard the swipe operation, but its text,
`swipeId`, and `swipeCount` are not part of generation-basis equality.

### Packet-input contract

A hash of configuration and versioned contracts that can change the Prompt
Packet Recursion would prepare for the same source.

### Prepared Generation Artifact

The atomic in-memory object containing the packet, hand, generation basis,
packet-input contract, and integrity hash.

## Critical Identity Rule

The output assistant must not be included in the reusable generation-basis
hash. Its text and active `swipeId` change by definition during a swipe.

```text
Messages before assistant       Must match
User request                    Must match
Source-window contract          Must match
Packet-producing configuration  Must match
Assistant output text           Deliberately ignored
Assistant swipe identity        Deliberately ignored for equality
```

Swipe metadata on earlier messages remains part of the source identity. If an
older assistant's active swipe changes, that is a real source mutation and
must produce a different generation basis even when its displayed text happens
to be identical.

## Desired Behavior

| Scenario | Expected behavior |
| --- | --- |
| Latest assistant is swiped and the generation basis is unchanged | Reinstall the same packet and hand; make zero Recursion provider calls. |
| The assistant output displaces older rows from a full message- or character-bounded source window | Reuse when every still-observable pre-assistant source identity is an exact suffix of the prepared basis. |
| The user waits longer than two minutes before swiping | Reuse if source and contracts still match; elapsed time alone is not staleness. |
| A swipe is stopped and the user swipes again | Preserve and reuse the last-known-good artifact when the generation basis still matches. |
| The prepared packet contains zero selected cards | It remains a valid artifact if the packet and hand schemas are valid. |
| Force Fresh is armed | Bypass the artifact, scene-card cache, and Rapid warm reuse. |
| SillyTavern explicitly requests Regenerate | Bypass same-turn packet reuse. |
| A preceding message is edited, deleted, added, hidden, or switched to another active swipe | Reject packet reuse and use the normal preparation pipeline. |
| A new user message is added | Reject packet reuse. |
| Chat or scene identity changes | Clear the hot artifact and installed prompt. |
| Packet-affecting settings change | Reject packet reuse. |
| Provider model, profile, routing, temperature, or token contract changes | Reject packet reuse. |
| Active deck card text changes while its ID stays the same | Reject packet reuse through the deck revision hash. |
| Enhancement-only settings change after generation | Preserve packet reuse because Enhancement does not produce the generation packet. |
| Provider health changes but provider configuration does not | Preserve a complete valid artifact; no provider call is needed. |
| Host source changes between cache validation and prompt installation | Skip installation as stale; do not fall through and install the cached packet. |
| Page reloads | No packet hit in V1; use persisted scene-card cache and the normal pipeline. |

## Architecture

### Canonical Runtime State

`lastPreparedGeneration` becomes the sole mutable owner of the reusable packet
and hand:

```js
let lastPreparedGeneration = null;
```

The runtime view may continue exposing `lastPacket` and `lastHand` for UI,
diagnostics, Last Brief, and Enhancement consumers, but they are derived:

```js
function preparedPacket() {
  return lastPreparedGeneration?.packet || null;
}

function preparedHand() {
  return lastPreparedGeneration?.hand || { cards: [], omitted: [] };
}

function runtimeView() {
  return {
    // Existing public view names remain useful; ownership is no longer split.
    lastPacket: preparedPacket(),
    lastHand: preparedHand(),
    preparedGeneration: preparedGenerationSummary(lastPreparedGeneration)
  };
}
```

Because Recursion is pre-alpha, implementation should update internal callers
to the canonical artifact rather than maintaining independently writable
legacy fields.

`lastBrief` remains a distinct inspection lifecycle. It may retain a public
copy of the most recently committed packet and hand, but it is not the
authority for cache reuse.

### Pure Prepared-Generation Module

Add `src/runtime/prepared-generation.mjs` for the pure artifact and validation
contract. Runtime-specific snapshot extraction remains in `src/runtime.mjs`.

```js
import { hashJson, nowIso } from '../core.mjs';
import { validatePromptPacket } from '../prompt.mjs';

export const PREPARED_GENERATION_VERSION = 1;

export function createPreparedGenerationArtifact({
  packet,
  hand,
  basis,
  contract
}) {
  validatePromptPacket(packet);
  if (!hand || !Array.isArray(hand.cards) || !Array.isArray(hand.omitted)) {
    throw new TypeError('Prepared generation hand is invalid.');
  }
  const body = {
    schema: 'recursion.preparedGeneration.v1',
    version: PREPARED_GENERATION_VERSION,
    packet,
    hand,
    basis,
    contract,
    preparedAt: nowIso()
  };
  return {
    ...body,
    artifactHash: hashJson(body)
  };
}

export function preparedGenerationIntegrityIsValid(artifact) {
  if (artifact?.schema !== 'recursion.preparedGeneration.v1') return false;
  if (artifact?.version !== PREPARED_GENERATION_VERSION) return false;
  if (!artifact?.packet || !artifact?.hand || !artifact?.basis || !artifact?.contract) return false;
  try {
    validatePromptPacket(artifact.packet);
  } catch {
    return false;
  }
  if (!Array.isArray(artifact.hand.cards) || !Array.isArray(artifact.hand.omitted)) {
    return false;
  }
  const { artifactHash, ...body } = artifact;
  return Boolean(artifactHash) && artifactHash === hashJson(body);
}
```

This module must not read settings, host state, storage, or global runtime
state. That keeps its behavior deterministic and directly testable.

## Generation Basis Contract

### Shape

```ts
type SourceWindowIdentity = {
  mesid: number;
  role: 'user' | 'assistant' | 'system';
  textHash: string;
  swipeId?: number;
  swipeCount?: number;
  activeSwipeTextHash?: string;
};

type PreparedGenerationBasis = {
  chatKey: string;
  sceneKey: string;
  sceneFingerprint: string;
  latestMesId: number;
  sourceRevisionHash: string;
  sourceWindow: SourceWindowIdentity[];
  sourceWindowContractHash: string;
};
```

`latestMesId` identifies the last source message in the generation basis,
normally the user message that requested the assistant response. It is not the
ID of the assistant output later being swiped.

### Building the Basis

The original generation and a later latest-assistant swipe must normalize to
the same basis:

```js
function generationBasisForSnapshot(snapshot, settings) {
  const source = normalizeSnapshot(snapshot);
  const retention = normalizeRetentionSettings(settings.retention);
  return {
    chatKey: safeText(source.chatKey || DEFAULT_CHAT_ID, 160),
    sceneKey: safeText(source.sceneKey || DEFAULT_SCENE_KEY, 160),
    sceneFingerprint: safeText(source.sceneFingerprint || '', 180),
    latestMesId: numberOr(source.latestMesId, 0),
    sourceRevisionHash: activeSourceRevisionHash(source),
    sourceWindow: sourceWindowMessages(source),
    sourceWindowContractHash: hashJson({
      sourceWindowMessages: retention.sourceWindowMessages,
      sourceWindowCharacters: retention.sourceWindowCharacters
    })
  };
}

function generationBasisForLatestAssistantSwipe(snapshot, messageId, settings) {
  const latestAssistant = latestVisibleAssistantEntry(snapshot);
  if (!latestAssistant) return null;
  const latestMessageId = numberOr(
    latestAssistant.message?.mesid,
    latestAssistant.index
  );
  if (messageId !== null && messageId !== latestMessageId) return null;
  const sourceBeforeAssistant = snapshotWithoutLatestAssistant(
    snapshot,
    latestAssistant
  );
  return sourceBeforeAssistant
    ? generationBasisForSnapshot(sourceBeforeAssistant, settings)
    : null;
}
```

The implementation should reuse the existing normalized snapshot and
source-window helpers rather than creating a parallel message-normalization
contract.

### Matching

The host applies the source-window message and character bounds before runtime
removes the latest assistant. When the window is full, the assistant output may
displace one or more older source messages. The current pre-assistant window can
therefore be a shorter exact suffix of the prepared basis without any source
mutation.

Matching is pure and exported by `src/runtime/prepared-generation.mjs`:

```js
export function compareGenerationBasis(
  expected,
  current,
  { allowBoundedSuffix = false } = {}
) {
  const metadataMatches = expected?.chatKey === current?.chatKey
    && expected?.sceneKey === current?.sceneKey
    && expected?.sceneFingerprint === current?.sceneFingerprint
    && expected?.latestMesId === current?.latestMesId
    && expected?.sourceWindowContractHash === current?.sourceWindowContractHash;
  if (!metadataMatches) {
    return { matches: false, mode: 'none', reason: 'basis-metadata-mismatch' };
  }

  const expectedWindow = Array.isArray(expected?.sourceWindow)
    ? expected.sourceWindow
    : [];
  const currentWindow = Array.isArray(current?.sourceWindow)
    ? current.sourceWindow
    : [];
  if (!expectedWindow.length || !currentWindow.length) {
    return { matches: false, mode: 'none', reason: 'basis-window-empty' };
  }

  if (
    expected?.sourceRevisionHash === current?.sourceRevisionHash
    && hashJson(expectedWindow) === hashJson(currentWindow)
  ) {
    return { matches: true, mode: 'exact', reason: 'basis-exact' };
  }

  if (
    allowBoundedSuffix
    && currentWindow.length < expectedWindow.length
    && hashJson(currentWindow) === hashJson(
      expectedWindow.slice(-currentWindow.length)
    )
  ) {
    return {
      matches: true,
      mode: 'bounded-suffix',
      reason: 'basis-observable-suffix'
    };
  }

  return { matches: false, mode: 'none', reason: 'basis-window-mismatch' };
}
```

Every metadata field and at least one currently observable source identity are
required. A missing field or empty post-assistant source window is a miss.
Suffix matching is allowed only for a classified latest-assistant swipe. Direct
same-snapshot reuse and ordinary generation preparation require `mode:
'exact'`.

The basis stores only compact message identities and hashes, never source text.
An edit, deletion, insertion, visibility change, or older-message swipe inside
the observable suffix changes that suffix and produces a miss. A mutation
outside Recursion's configured bounded window is intentionally outside the
cache-freshness contract.

## Packet-Input Contract

### Principle

Hash only values that can change the desired Prompt Packet for the same
generation basis. Do not hash unrelated UI state or transient health.

### Shape

```ts
type PreparedGenerationContract = {
  preparedGenerationVersion: number;
  promptPacketVersion: number;
  runtimeCacheContractVersion: number;
  promptContractHash: string;
  providerContractHash: string;
  cardCatalogHash: string;
  activeDeckRevisionHash: string;
  cardEligibilityHash: string;
  packetInputHash: string;
};
```

### Settings Signature

Add a dedicated signature instead of reusing the broader scene-cache signature:

```js
function preparedGenerationSettingsSignature(settings = {}) {
  const normalized = settingsWithRuntimeCardScope(settings, { normalize: true });
  const retention = normalizeRetentionSettings(normalized.retention);
  return {
    enabled: normalized.enabled,
    mode: normalized.mode,
    pipelineMode: normalized.pipelineMode,
    cardScope: normalized.cardScope,
    strength: normalized.strength,
    minCards: normalized.minCards,
    maxCards: normalized.maxCards,
    reasoningLevel: normalized.reasoningLevel,
    promptFootprint: normalized.promptFootprint,
    focus: normalized.focus,
    reasonerUse: normalized.reasonerUse,
    storyFormOverride: normalized.storyFormOverride,
    injection: normalizeInjectionSettings(normalized.injection),
    retention: {
      sourceWindowMessages: retention.sourceWindowMessages,
      sourceWindowCharacters: retention.sourceWindowCharacters,
      providerVisibleMessages: retention.providerVisibleMessages
    },
    providers: {
      utility: cacheProviderSettingsSignature(normalized.providers?.utility),
      reasoner: cacheProviderSettingsSignature(normalized.providers?.reasoner)
    }
  };
}
```

Enhancement settings are deliberately absent. Diagnostics, UI state, and
retention values unrelated to source/provider context are also absent.

### Active Deck Revision

Card ID eligibility is insufficient because card contents can change while the
ID remains stable. Hash the runnable Active and Priority card inputs, not
draft/off cards or category organization that cannot affect packet content:

```js
function activeDeckRevisionHash(settings = {}) {
  const eligibility = activeCardDeckEligibility(settings);
  return hashJson({
    activeDeckId: eligibility.activeDeckId,
    sourceCardsByFamily: activeCardDeckSourceCards(settings)
  });
}
```

### Contract Construction

```js
function preparedGenerationContract(settings = {}) {
  const cacheVersions = cacheContractVersions(settings);
  const contract = {
    preparedGenerationVersion: PREPARED_GENERATION_VERSION,
    promptPacketVersion: PROMPT_PACKET_VERSION,
    runtimeCacheContractVersion: RUNTIME_CACHE_CONTRACT_VERSION,
    promptContractHash: cacheVersions.promptContractHash,
    providerContractHash: cacheVersions.providerContractHash,
    cardCatalogHash: cacheVersions.cardCatalogHash,
    activeDeckRevisionHash: activeDeckRevisionHash(settings),
    cardEligibilityHash: cacheVersions.cardEligibilityHash
  };
  return {
    ...contract,
    packetInputHash: hashJson({
      ...contract,
      settings: preparedGenerationSettingsSignature(settings)
    })
  };
}
```

The artifact stores only contract and input hashes, not the normalized settings
object used to calculate them. Raw API keys, bearer tokens, transcript text,
provider endpoints, profile IDs, model names, and provider responses must not
enter cache diagnostics or journals.

## Cache Decision Contract

The pure validator returns an explicit decision rather than a boolean:

```js
export function validatePreparedGenerationArtifact(
  artifact,
  {
    basis,
    packetInputHash,
    forceFresh = false,
    allowBoundedSuffix = false
  } = {}
) {
  if (forceFresh) {
    return { decision: 'bypassed', reason: 'force-fresh' };
  }
  if (!artifact) {
    return { decision: 'miss', reason: 'artifact-missing' };
  }
  if (!preparedGenerationIntegrityIsValid(artifact)) {
    return { decision: 'invalid', reason: 'artifact-integrity' };
  }
  const basisComparison = compareGenerationBasis(
    artifact.basis,
    basis,
    { allowBoundedSuffix }
  );
  if (!basisComparison.matches) {
    return {
      decision: 'miss',
      reason: 'generation-basis-mismatch',
      basisMode: basisComparison.mode,
      basisReason: basisComparison.reason
    };
  }
  if (artifact.contract.packetInputHash !== packetInputHash) {
    return { decision: 'miss', reason: 'packet-input-mismatch' };
  }
  return {
    decision: 'hit',
    reason: 'prepared-generation-exact-match',
    basisMode: basisComparison.mode
  };
}
```

The implementation returns detailed internal mismatch fields for tests and
diagnostics while keeping user-visible labels concise.

## Runtime Lifecycle

### Creating a Candidate

Normal Standard, Rapid, or Fused preparation builds a local candidate:

```js
const candidate = createPreparedGenerationArtifact({
  packet,
  hand,
  basis: generationBasisForSnapshot(promptSnapshot, settings),
  contract: preparedGenerationContract(settings)
});
```

The candidate does not immediately replace the last-known-good artifact.

### Committing

Commit only after `installPrompt(...)` succeeds:

```js
const install = await installPrompt(host, candidate.packet);
if (install?.ok !== false) {
  lastPreparedGeneration = candidate;
  readyLastBrief(candidate.packet, candidate.hand, {
    runId,
    reason: 'packet-installed'
  });
}
```

If composition, validation, freshness checking, or installation fails:

- do not commit the candidate;
- do not corrupt the previous artifact;
- record the concrete failure;
- allow host generation to continue without Recursion when that is the current
  fail-soft contract.

Keeping an older last-known-good artifact in memory is safe because every
future hit must independently match the current generation basis and
packet-input contract.

### Reusing

```js
async function tryPreparedGenerationReuse({
  runId,
  snapshot,
  swipeMessageId,
  settings,
  forceFresh = false
}) {
  const basis = generationBasisForLatestAssistantSwipe(
    snapshot,
    swipeMessageId,
    settings
  );
  if (!basis) {
    return { reused: false, decision: 'miss', reason: 'swipe-basis-unavailable' };
  }

  const contract = preparedGenerationContract(settings);
  const decision = validatePreparedGenerationArtifact(
    lastPreparedGeneration,
    {
      basis,
      packetInputHash: contract.packetInputHash,
      forceFresh,
      allowBoundedSuffix: true
    }
  );

  recordCacheDecision(runId, {
    ...decision,
    kind: 'prepared-generation',
    providerCallsSkipped: decision.decision === 'hit'
      ? [
          'utilityArbiter',
          'standardCardCalls',
          'fusedCardBundle',
          'rapidTurnDelta',
          'guidanceComposer',
          'reasonerComposer'
        ]
      : []
  });

  if (decision.decision !== 'hit') {
    return { reused: false, ...decision };
  }

  return reinstallPreparedGeneration({
    runId,
    expectedBasis: basis,
    swipeMessageId,
    artifact: lastPreparedGeneration,
    settings
  });
}
```

The exact skipped-role list may be reduced to roles relevant to the active
pipeline, but it must never claim that a call was skipped if that role was not
part of the current preparation policy.

## Final Host Freshness Barrier

Initial cache validation is not sufficient. The host may change while Recursion
waits for the serialized prompt mutation section.

Cached reinstallation gets a swipe-aware equivalent of
`recheckPromptInstallSnapshot(...)`:

```js
async function recheckPreparedGenerationBasis({
  expectedBasis,
  swipeMessageId,
  settings
}) {
  try {
    const currentSnapshot = await readSnapshot();
    const currentBasis = generationBasisForLatestAssistantSwipe(
      currentSnapshot,
      swipeMessageId,
      settings
    );
    const comparison = compareGenerationBasis(
      expectedBasis,
      currentBasis,
      { allowBoundedSuffix: true }
    );
    if (!comparison.matches) {
      return {
        ok: false,
        reason: 'stale-generation-basis',
        currentSnapshot,
        comparison
      };
    }
    return {
      ok: true,
      currentSnapshot,
      currentBasis,
      basisMode: comparison.mode
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'snapshot-recheck-failed',
      error: sanitizePromptError(
        error,
        'RECURSION_PREPARED_GENERATION_RECHECK_FAILED',
        'Prepared generation snapshot recheck failed.'
      )
    };
  }
}
```

The recheck occurs inside the serialized prompt mutation section and
immediately before installation:

```js
async function reinstallPreparedGeneration({
  runId,
  expectedBasis,
  swipeMessageId,
  artifact,
  settings
}) {
  return runPromptMutationSection(runId, async () => {
    if (!isActiveRun(runId)) return supersededResult(runId);

    const freshness = await recheckPreparedGenerationBasis({
      expectedBasis,
      swipeMessageId,
      settings
    });
    if (!freshness.ok) {
      return skipPreparedGenerationInstall(runId, {
        reason: freshness.reason,
        expectedBasis,
        currentSnapshot: freshness.currentSnapshot,
        packet: artifact.packet,
        hand: artifact.hand,
        error: freshness.error
      });
    }

    if (!isActiveRun(runId)) return supersededResult(runId);
    const install = await installPrompt(host, artifact.packet);
    if (install?.ok === false) {
      return {
        ok: false,
        reused: false,
        reason: 'prompt-install-failed',
        packet: artifact.packet,
        hand: artifact.hand,
        install
      };
    }
    readyLastBrief(artifact.packet, artifact.hand, {
      runId,
      reason: 'prepared-generation-reused'
    });
    return {
      ok: true,
      reused: true,
      reason: 'prepared-generation-exact-match',
      basisMode: freshness.basisMode,
      packet: artifact.packet,
      hand: artifact.hand,
      install
    };
  });
}
```

Add a dedicated prepared-generation stale-install journal helper because the
existing helper expects a full snapshot. Do not weaken the swipe-aware
generation-basis comparison to fit the old helper. The dedicated helper records
only safe expected/current basis hashes and returns the same fail-soft
`{ ok: true, skipped: true, reason }` shape as other stale-install paths.

## Swipe Marker and Stop Semantics

The retry marker classifies the host event; it is not the cache itself.

```ts
type PendingLatestAssistantSwipe = {
  eventName: string;
  messageId: number | null;
  recordedAt: string;
};
```

Source and contract hashes determine whether the artifact is valid. A fixed
two-minute age does not.

The marker is cleared by:

- consuming the swipe attempt;
- Force Fresh or Regenerate;
- a non-latest-assistant source mutation;
- chat change;
- scene-cache reset;
- teardown.

For a stopped swipe:

```js
const attempt = runState.current().activeAttempt;
const preserve = attempt?.kind === 'swipe'
  && Boolean(lastPreparedGeneration);

if (preserve) {
  runState.setLatestAssistantSwipeRetry({
    eventName: 'message_swiped',
    messageId: finiteNumberOrNull(details.messageId),
    recordedAt: nowIso()
  });
}
```

A valid zero-card artifact is preserved. `hand.cards.length > 0` is not a
validity requirement.

Cancellation must:

- abort active Recursion work;
- clear installed prompt lanes as required by the host-stop contract;
- preserve the committed artifact;
- avoid scene-cache invalidation;
- avoid converting cancellation into a source mutation;
- allow the next exact swipe to reuse the artifact.

## Invalidation

### Hard clear

Clear `lastPreparedGeneration` on:

- chat change;
- explicit scene-cache reset;
- Recursion disable or teardown;
- a source edit, deletion, insertion, visibility change, or older-message
  swipe;
- a confirmed new user turn that cannot match the stored basis.

### Contract miss without destructive clear

It is acceptable to retain the artifact but reject it on:

- packet-affecting settings change;
- active deck revision change;
- provider configuration change;
- runtime, provider, prompt, card, or packet contract change.

The next successful installation atomically replaces it. Keeping the old
artifact until then preserves last-known-good diagnostics without permitting
stale reuse.

### No invalidation

Do not invalidate the artifact for:

- Enhancement mode or context-depth changes;
- diagnostics display changes;
- UI expansion/collapse state;
- transient provider health changes;
- navigation among existing latest-assistant swipes when the pre-assistant
  generation basis is unchanged;
- elapsed wall-clock time alone.

## Decision Order

Generation preparation uses this order:

```text
1. Recursion disabled?
   yes -> clear prompt; no reuse

2. Force Fresh or explicit Regenerate?
   yes -> bypass every reusable artifact

3. Explicit or classified latest-assistant swipe?
   yes -> validate Prepared Generation Artifact
          hit -> final host recheck -> reinstall -> return

4. Exact same full prompt snapshot?
   yes -> validate the same artifact contract
          hit -> final host recheck -> reinstall -> return

5. Rapid with valid warm artifact?
   yes -> run Rapid foreground path

6. Load and validate scene-card cache

7. Run Utility Arbiter

8. Reuse or generate cards, select hand, compose packet

9. Final host recheck, install, atomically commit artifact
```

The existing direct same-snapshot reuse path must use the same artifact and
contract validator. There should not be a stricter swipe validator and a looser
non-swipe packet validator.

## Diagnostics and Privacy

### Cache decision

```js
{
  decision: 'hit',
  kind: 'prepared-generation',
  reason: 'prepared-generation-exact-match',
  basisMode: 'exact | bounded-suffix',
  artifactHash: 'safe-hash',
  packetId: 'prompt-packet-...',
  handId: 'hand-...',
  providerCallsSkipped: [
    'utilityArbiter',
    'standardCardCalls',
    'guidanceComposer'
  ]
}
```

### Miss reasons

- `artifact-missing`
- `artifact-integrity`
- `swipe-basis-unavailable`
- `generation-basis-mismatch`
- `basis-metadata-mismatch`
- `basis-window-empty`
- `basis-window-mismatch`
- `packet-input-mismatch`
- `force-fresh`
- `explicit-regenerate`
- `stale-generation-basis`
- `snapshot-recheck-failed`

### Visible feedback

Use the existing compact status surface:

```text
Reusing prepared swipe context...
Recursion prompt reused for swipe retry.
```

Purple cached state remains authoritative for a successful hit. A stale final
recheck is a warning/skip, not a cache success.

### Redaction

Journals and exported diagnostics may contain:

- cache kind, decision, and reason;
- packet, hand, artifact, source, and contract hashes;
- compact message IDs;
- skipped provider role IDs.

They must not contain:

- transcript or swipe text;
- full packet sections;
- card prompt text;
- raw provider output;
- API keys, bearer tokens, or session identifiers;
- full `swipes[]` arrays.

The full artifact stays in volatile runtime memory and existing trusted
runtime views only. V1 does not persist it.

## Error Handling

- Missing or malformed artifact: record a miss and continue through normal
  generation preparation.
- Integrity mismatch: discard or replace the in-memory artifact; never install
  it.
- Contract mismatch: record a miss and continue normally.
- Snapshot recheck failure: skip cached installation; do not install based on
  an unverified host state.
- Prompt installation failure: report the real host failure, do not commit the
  failed candidate, and retain any previously committed artifact for a later
  independently validated retry.
- Superseded run: return the existing superseded result and allow the newer run
  to own prompt mutation.
- Storage failure: does not affect the in-memory artifact; scene-cache storage
  remains independently fail-soft.

## Implementation Strategy

### Phase 1: Pure contract and failing tests

1. Add `src/runtime/prepared-generation.mjs`.
2. Add `tools/scripts/test-prepared-generation.mjs` for artifact creation,
   integrity, exact and bounded-suffix basis matching, and packet-input
   matching.
3. Register the focused script in `tools/scripts/run-tests.mjs`; the maintained
   alpha gate inherits it through `tools/scripts/run-alpha-gate.mjs`.
4. Add failing runtime regressions for settings drift, final-install races,
   stopped-swipe retry, and bounded-window displacement before changing
   runtime behavior.
5. Run each new regression red against the current runtime, then green against
   the implementation. A test that never demonstrated the original failure is
   not accepted as regression evidence.

### Phase 2: Canonical artifact ownership

1. Replace independently mutable `lastPacket` and `lastHand` ownership with
   `lastPreparedGeneration`.
2. Derive existing runtime view fields and Last Brief inputs from the artifact.
3. Build candidates locally and commit only after successful installation.
4. Keep scene-cache `latestHand` metadata separate from the volatile full
   artifact.

### Phase 3: Unified identity and contract validation

1. Add `generationBasisForSnapshot(...)`.
2. Add `generationBasisForLatestAssistantSwipe(...)`.
3. Add exact and observable-suffix `compareGenerationBasis(...)` modes.
4. Add `preparedGenerationSettingsSignature(...)`.
5. Add active deck content revision hashing.
6. Route direct same-snapshot and latest-assistant swipe reuse through one
   validator.
7. Keep Force Fresh and Regenerate ahead of reuse.

### Phase 4: Freshness and stop lifecycle

1. Add the final swipe-aware host snapshot recheck inside
   `runPromptMutationSection(...)`.
2. Remove wall-clock age as a semantic reuse condition.
3. Repair stopped-swipe marker construction.
4. Preserve valid zero-card artifacts.
5. Keep cancellation separate from source invalidation.

### Phase 5: Diagnostics and documentation

1. Rename cache diagnostics from the implementation-oriented `swipe-packet`
   kind to `prepared-generation` and update code, tests, docs, and examples in
   place.
2. Record precise hit, miss, bypass, invalid, and stale-install reasons.
3. Update:
   - `docs/architecture/CACHE_USE_AND_REUSE_SPEC.md`;
   - `docs/architecture/RUNTIME_ARCHITECTURE.md`;
   - `docs/technical/RUNTIME_TURN_SEQUENCE.md`;
   - `docs/testing/TESTING_STRATEGY.md`;
   - relevant live smoke documentation.
4. Keep this design and those active docs consistent about source-window
   defaults and packet reuse.

### Phase 6: Served-host proof

1. Run deterministic runtime and extension suites.
2. Sync the tested source to the served Recursion extension.
3. Hash-compare repository and served modules.
4. Reload SillyTavern to avoid stale browser modules.
5. Retain the current synthetic served-module check as deterministic browser
   evidence, not live-host certification.
6. Expand `tools/scripts/prove-live-swipe-reuse.mjs` with a strict native-host
   path that does not construct an in-page fake runtime or provider router.
7. Drive the visible SillyTavern latest-assistant swipe control and actual
   extension event/interceptor path.
8. Inspect story-generation continuation, Recursion provider-call absence, run
   journal, prompt store, cache decision, installed packet ID, visible
   progress, and chat shape.

## Test Methodology and Maintained Gates

### Test ownership

| Test surface | Owned methodology |
| --- | --- |
| `tools/scripts/test-prepared-generation.mjs` | Pure artifact schema, integrity, exact/suffix basis comparison, contract hashing, and decision reasons. |
| `tools/scripts/test-runtime.mjs` | Provider-call counts, canonical artifact lifecycle, commit atomicity, stop/retry, Force Fresh, settings/deck/provider mutations, races, and diagnostics. |
| `tools/scripts/test-extension-smoke.mjs` | `MESSAGE_SWIPED` classification, sparse payload fallback, event/interceptor overlap, and teardown. |
| `tools/scripts/test-live-harness.mjs` | Dedicated-user rejection, strict-vs-synthetic proof classification, report shape, redaction, and fail-closed behavior. |
| `tools/scripts/prove-live-swipe-reuse.mjs` | Actual served-copy and native SillyTavern swipe certification. |

Add the focused pure test to the package and maintained suite:

```json
{
  "scripts": {
    "test:prepared-generation": "node tools/scripts/test-prepared-generation.mjs"
  }
}
```

`npm.cmd test` and `node tools/scripts/run-alpha-gate.mjs` must execute it
through `run-tests.mjs`. A standalone passing command that is absent from the
maintained gates is incomplete.

### Red-green regression order

Before runtime implementation, add and run focused failures for:

1. full message-window displacement;
2. character-budget displacement;
3. packet-affecting settings drift;
4. stopped-swipe marker preservation;
5. source mutation during cached prompt installation.

Record the expected failing assertion for each. Implement one contract boundary
at a time, rerun the focused test, then rerun the complete maintained suite.

### Table-driven one-variable mutation tests

Contract and source mutation tests change exactly one field from a known-good
artifact. Each row declares the expected cache decision, basis mode, provider
call delta, and packet identity outcome:

```js
const cases = [
  {
    name: 'strength changes',
    mutate: ({ settings }) => settingsStore.update({ strength: 'strong' }),
    decision: 'miss',
    reason: 'packet-input-mismatch',
    providerCallsIncrease: true,
    packetIdStable: false
  },
  {
    name: 'enhancement depth changes',
    mutate: ({ settings }) => settingsStore.update({
      enhancements: { ...settings.enhancements, contextMessages: 20 }
    }),
    decision: 'hit',
    reason: 'prepared-generation-exact-match',
    providerCallsIncrease: false,
    packetIdStable: true
  }
];

for (const testCase of cases) {
  const harness = await prepareKnownGoodArtifact();
  await testCase.mutate(harness);
  const beforeCalls = harness.providerCalls.length;
  const result = await harness.swipe();
  assertEqual(result.decision, testCase.decision, testCase.name);
  assertEqual(result.reason, testCase.reason, testCase.name);
  assertEqual(
    harness.providerCalls.length > beforeCalls,
    testCase.providerCallsIncrease,
    testCase.name
  );
  assertEqual(
    result.packet?.packetId === harness.originalPacketId,
    testCase.packetIdStable,
    testCase.name
  );
}
```

Do not reuse mutable settings, storage, runtime, or provider-call arrays across
table rows. Every row starts from a fresh known-good artifact so failures remain
attributable to the named mutation.

### Cache-hit oracle

No single signal is sufficient. A deterministic cache hit requires all of:

- `result.reused === true`;
- cache decision `hit`;
- reason `prepared-generation-exact-match`;
- expected `basisMode`;
- unchanged artifact, packet, and hand IDs;
- exactly one additional prompt installation;
- zero additional Recursion provider calls;
- no scene-cache read or write required by the hit;
- no warning/error journal event;
- host generation remains allowed to continue.

A purple progress row or stable packet ID alone is supporting evidence, not a
pass oracle.

### Cache-miss oracle

A deliberate miss requires:

- the exact expected miss/bypass reason;
- no cached packet installation;
- a new packet ID after successful normal preparation;
- the expected provider roles for the active pipeline;
- no stale artifact mutation before the new candidate installs;
- no fallback to a different cache kind being mislabeled as a Prepared
  Generation hit.

### Performance methodology

The functional performance contract is zero provider and storage work on a hit.
Add a deterministic 20-swipe loop using `performance.now()`:

```js
const elapsed = [];
for (let index = 0; index < 20; index += 1) {
  host.advanceLatestAssistantSwipeIdentity();
  const startedAt = performance.now();
  const result = await runtime.prepareForGeneration({
    hostGeneration: true,
    generationType: 'swipe'
  });
  elapsed.push(performance.now() - startedAt);
  assertEqual(result.reused, true, `repeat swipe ${index + 1}`);
}

assert(Math.max(...elapsed) <= 250, 'prepared swipe reuse stays below 250ms');
```

The deterministic harness uses immediate fake prompt installation and no
artificial sleeps. Report median and maximum elapsed time. Live proof records
elapsed time for regression evidence but does not use a machine-independent
latency threshold; its pass oracle remains zero Recursion provider calls and
successful native host continuation.

## Required Deterministic Tests

### Bounded-window displacement

Message-cap fixture:

1. Prepare a packet from exactly `sourceWindowMessages` visible source rows.
2. Append the latest assistant output so host bounding displaces the oldest
   source row.
3. Remove the output through
   `generationBasisForLatestAssistantSwipe(...)`.
4. Prove the remaining identities exactly equal the suffix of the prepared
   basis.
5. Require a hit with `basisMode: 'bounded-suffix'` and zero provider calls.

Character-cap fixture:

1. Fill the source window to within a few characters of
   `sourceWindowCharacters`.
2. Append a long assistant output that displaces multiple older source rows
   before runtime sees the bounded host snapshot.
3. Remove the output and prove the still-observable identities form the exact
   prepared suffix.
4. Require the same bounded-suffix hit.

Negative controls:

- edit the first currently observable suffix row -> miss;
- change an observable older assistant's `swipeId` -> miss;
- insert a new source row inside the observable suffix -> miss;
- delete a non-prefix row from the observable suffix -> miss;
- present an empty pre-assistant observable window -> miss with
  `basis-window-empty`;
- change only a row outside both configured bounds -> hit, because it is
  outside Recursion's declared freshness contract;
- request suffix matching for a direct same-snapshot reuse -> miss; suffix mode
  is latest-assistant-swipe-only.

Pure tests assert `compareGenerationBasis(...)` directly. Runtime tests also
assert the provider-call and prompt-install oracles so a correct pure matcher
cannot be wired incorrectly.

### Standard, Rapid, and Fused exact reuse

For each pipeline:

```js
const first = await runtime.prepareForGeneration({
  userMessage,
  hostGeneration: true
});
const callsAfterFirst = providerCalls.length;
const packetId = first.packet.packetId;

activeSnapshot = snapshotWithLatestAssistant({
  sourceMessages,
  assistantText: 'First response',
  swipeId: 1,
  swipeCount: 2
});

const second = await runtime.prepareForGeneration({
  hostGeneration: true,
  generationType: 'swipe'
});

assertEqual(second.reused, true);
assertEqual(second.packet.packetId, packetId);
assertEqual(providerCalls.length, callsAfterFirst);
assertEqual(runtime.view().lastCacheDecision.kind, 'prepared-generation');
```

Run this fixture once with a short exact basis and once with a full bounded
window. The short case requires `basisMode: 'exact'`; the full case requires
`basisMode: 'bounded-suffix'`.

### Repeated swipe lifecycle

For Standard, Rapid, and Fused, run:

```text
prepare -> swipe -> swipe -> stop -> swipe -> swipe
```

Across the complete sequence, assert:

- every swipe reuses the committed artifact;
- no swipe adds a Recursion provider call;
- packet, hand, and artifact IDs remain stable;
- each attempt performs exactly one prompt installation;
- each attempt records exactly one cache decision;
- event/interceptor overlap does not duplicate installation;
- stopping preserves the artifact and re-arms classification;
- no retry marker survives after its attempt is consumed;
- no age-based expiry occurs.

### Stop then swipe

```js
await runtime.prepareForGeneration({
  userMessage,
  hostGeneration: true
});

activeSnapshot = snapshotWithLatestAssistant({
  sourceMessages,
  assistantText: 'Stopped response',
  swipeId: 1,
  swipeCount: 2
});

await runtime.prepareForGeneration({
  hostGeneration: true,
  generationType: 'swipe'
});
await runtime.handleHostGenerationStopped({
  eventName: 'generation_stopped',
  messageId: assistantMesId
});

const callsBeforeRetry = providerCalls.length;
const retry = await runtime.prepareForGeneration({
  hostGeneration: true,
  generationType: 'swipe'
});

assertEqual(retry.reused, true);
assertEqual(providerCalls.length, callsBeforeRetry);
```

This test must fail if the retry marker lacks the fields consumed by runtime.

### Final recheck race

Block the serialized prompt mutation section, validate an exact cache hit,
mutate a preceding host message, then release installation:

```js
assertEqual(result.skipped, true);
assertEqual(result.reason, 'stale-generation-basis');
assertEqual(installed.length, installsBeforeReuse);
```

Also assert:

- no successful cache-hit journal event is written after the stale recheck;
- the previously committed artifact remains byte-identical;
- a superseding run can subsequently prepare and install normally.

### Contract mutations

Each of these must force a miss and new preparation:

- `strength`;
- `cardScope`;
- `reasoningLevel`;
- `reasonerUse`;
- prompt footprint;
- injection settings;
- story-form override;
- provider profile or model;
- provider sampling/token settings;
- pipeline mode;
- active deck selection;
- card prompt text changed under the same card ID;
- source-window or provider-visible-message depth;
- prompt/provider/card contract version.

### Contract-neutral mutations

These must preserve an exact hit:

- Enhancement mode;
- Enhancement application mode;
- Enhancement context depth;
- diagnostics display settings;
- transient provider health.

### Source mutations

These must force a miss:

- preceding user edit;
- preceding assistant edit;
- preceding deletion;
- new user message;
- older-message swipe;
- active chat change;
- scene identity change;
- source-window contract change.

### Additional edge cases

- exact hit after more than two minutes;
- valid packet with zero selected cards;
- malformed artifact hash;
- packet install failure followed by an exact retry;
- duplicate or sparse `MESSAGE_SWIPED` payload;
- late provider completion cannot replace the committed artifact;
- Force Fresh and explicit Regenerate always bypass.

### Atomicity and failure injection

Use controlled promises to stop execution at:

- candidate composed but not installed;
- cached hit validated but waiting for prompt mutation;
- prompt installation in progress;
- old provider result completing after supersession;
- scene-cache save completing after prompt installation.

At every boundary, capture the committed artifact hash before release. Require:

- a failed or superseded candidate never becomes committed;
- a failed cached installation retains the previous artifact;
- a successful new installation changes the artifact exactly once;
- late provider or storage completion cannot overwrite the newer artifact;
- `lastPacket` and `lastHand` views always come from the same committed
  artifact.

### Privacy and diagnostic methodology

Seed fixtures with unique canaries for:

- transcript text;
- card prompt text;
- provider endpoint;
- provider profile ID;
- model name;
- API key and bearer token.

Then run hit, miss, invalid, stale-recheck, and install-failure paths. Pass
exported diagnostics, journals, progress details, and
`preparedGenerationSummary(...)` through the existing `assertNoSecretText`
helper and explicit canary checks:

```js
for (const canary of privateCanaries) {
  assert(
    !JSON.stringify(publicEvidence).includes(canary),
    `prepared generation evidence omits ${canary}`
  );
}
assertNoSecretText(publicEvidence, 'prepared generation evidence');
```

The trusted in-memory packet and hand are excluded from this redaction oracle;
the public summary, cache decisions, journal, and exported diagnostics are not.

## Extension and Host-Boundary Tests

Extension smoke must prove:

- latest-assistant `MESSAGE_SWIPED` marks retry instead of clearing the
  artifact;
- older-message `MESSAGE_SWIPED` performs full source-change cleanup;
- the generation interceptor's explicit `generationType: "swipe"` remains the
  authoritative fallback when the event payload is sparse;
- event and interceptor overlap does not duplicate work;
- stop events preserve the committed artifact and retry classification.

The fake host chat must match real SillyTavern behavior: the current assistant
row remains in `context.chat`, while the generation interceptor payload may end
on the preceding user row.

## Live SillyTavern Proof

The live proof must use a dedicated `recursion-soak-*` user and the actually
served extension copy.

### Proof classification

The existing `prove-live-swipe-reuse.mjs` path imports the served runtime in a
browser page but constructs an in-memory host and fake provider router. Preserve
that useful check as `served-module` evidence, but it cannot produce a strict
live pass.

A strict pass must:

- use the runtime mounted by the installed extension;
- use SillyTavern's real `context.chat`;
- trigger the visible/native latest-assistant swipe control;
- pass through the actual `MESSAGE_SWIPED` subscription and generation
  interceptor;
- use the real prompt store and host generation path;
- never call `createRecursionRuntime(...)` or install a fake provider router
  inside `page.evaluate(...)`.

The report records one of:

- `served-module-pass`;
- `strict-live-pass`;
- `fail`;
- `environment-fail`;
- `stale-extension`;
- `unsafe-user`.

Only `strict-live-pass` satisfies this design's live acceptance criterion.

### Strict oracle

Capture these baselines before the native swipe:

- chat row count, latest assistant `mesid`, `swipe_id`, and `swipes.length`;
- committed artifact, packet, and hand IDs;
- Recursion run-journal tail position;
- Recursion provider-call start count by role;
- prompt-store hashes for Recursion-owned keys;
- browser network request count for host story generation.

After the swipe settles, require:

- the same assistant row remains latest;
- `swipes.length` increases and the active `swipe_id` selects the new variant;
- at least one host story-generation request occurred;
- no new Recursion `provider.call.started` journal entry exists;
- no Recursion provider request role was observed;
- artifact, packet, and hand IDs are unchanged;
- Recursion prompt-store hashes match the prepared packet;
- exactly one `prepared-generation` cache decision exists for the attempt;
- no warning/error journal event or visible failure state exists;
- the assistant response completes through the real host path.

Network observation is supporting evidence for host continuation. The
run-journal provider-role delta is the authoritative Recursion-call oracle
because the host story model and Recursion providers may share an HTTP
endpoint.

Required sequence:

1. Verify the repository, installed extension, and served extension are
   byte-identical.
2. Run once with a short-window fixture and once with a configured-bound
   fixture.
3. Generate an assistant reply through visible SillyTavern controls.
4. Record the strict-oracle baselines.
5. Trigger a native latest-assistant swipe.
6. Verify one assistant row now owns multiple SillyTavern swipes.
7. Verify artifact, Prompt Packet, and hand IDs are unchanged.
8. Verify no Recursion provider request occurred.
9. Verify diagnostics report a `prepared-generation` hit with the expected
   `exact` or `bounded-suffix` basis mode.
10. Repeat a native swipe and verify another zero-call hit.
11. Stop a later swipe attempt.
12. Swipe again and verify the stopped-swipe retry makes zero Recursion
    provider calls.
13. Arm Force Fresh and swipe again.
14. Verify a new artifact/packet ID and new Recursion provider calls.

Evidence must include:

- repo-to-served file hashes;
- relevant provider request role IDs;
- compact run-journal events;
- cache decision snapshot;
- installed packet and hand IDs;
- visible progress state;
- chat message ID, active swipe ID, and swipe count without raw story text.

A failed live proof remains a failure. Tests or mock-provider evidence do not
substitute for the actual host path. Screenshots and traces are suppressed
during generation-enabled proof because they may capture story text; the strict
machine-readable report is the certification artifact.

## Acceptance Criteria

- Latest-assistant swipes with an unchanged generation basis and packet-input
  contract reinstall the exact same packet and hand.
- Full message- and character-bounded windows reuse through an exact observable
  suffix without requiring the displaced source rows to remain in the current
  host snapshot.
- Any mutation inside the observable suffix rejects reuse; an empty observable
  pre-assistant window rejects reuse.
- Exact hits make zero Recursion provider calls in Standard, Rapid, and Fused.
- The assistant output's text and active swipe ID do not prevent legitimate
  reuse.
- Swipe identity on any preceding message remains part of source freshness.
- Packet and hand have one canonical atomic owner.
- Artifacts are committed only after successful prompt installation.
- Packet-affecting settings, provider configuration, deck contents, and
  contract changes reject reuse.
- Enhancement-only and transient-health changes do not reject a complete
  artifact.
- A final host snapshot recheck occurs inside the serialized prompt mutation
  section.
- A host mutation during reuse prevents stale prompt installation.
- Stopping a swipe preserves the last-known-good artifact.
- The next exact swipe after a stop makes zero Recursion provider calls.
- Elapsed time alone does not invalidate an otherwise exact artifact.
- Valid zero-card packets can be reused.
- Force Fresh and explicit Regenerate always bypass reuse.
- Twenty repeated deterministic swipes preserve artifact, packet, and hand
  identity, make zero Recursion provider/storage calls, and each complete
  within the documented 250ms deterministic ceiling.
- Diagnostics report exact decisions and skipped provider roles without raw
  prompt, transcript, card, swipe, provider, or secret content.
- Pure, runtime, extension, and live-harness tests are registered in the
  maintained test and alpha gates.
- Known regressions demonstrate red-before-green evidence.
- The strict live proof uses the mounted extension, native SillyTavern swipe
  path, real prompt store, and real run journal; synthetic served-module proof
  is not accepted as live certification.
- Deterministic suites and the strict native SillyTavern proof both pass.

## Rejected Alternatives

### Cache only the Utility Arbiter

Rejected as the primary solution because it still leaves card generation,
selection, composition, and packet assembly. It also creates another cache
contract without accelerating the common exact-swipe case as much as a
complete artifact.

### Reuse `lastPacket` using transcript hashes only

Rejected because packet-affecting settings, deck contents, provider routing,
and contract versions can change while transcript hashes remain identical.

### Include the active output swipe in the cache key

Rejected because the output swipe changes by definition and would turn every
legitimate swipe into a miss.

### Persist complete packets in V1

Rejected for this pass because reload-safe persistence expands privacy,
retention, schema, and migration scope. Existing scene-card persistence gives a
safe fallback after reload.

### Use a fixed TTL as validity

Rejected because age is not evidence that source or packet inputs changed.
Explicit lifecycle events and exact hashes provide the real validity contract.
