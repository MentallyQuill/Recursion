# Recursion Card Packet Pipeline Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace lossy brief-style prompt composition with provider-authored guidance plus full raw selected card evidence across Standard and Rapid pipelines.

**Architecture:** Standard selects a hand, calls a provider `guidanceComposer`, and installs a card packet containing `recursion.guidance`, `recursion.cardEvidence`, and `recursion.guardrails`. Rapid warm V2 performs the same card and guidance work in the background, then foreground `rapidTurnDelta.v2` adds user-message-specific guidance while preserving raw cards. Runtime performs validation, serialization, installation, and diagnostics only; it does not semantically rewrite cards.

**Tech Stack:** JavaScript ES modules, SillyTavern extension host adapter, Recursion provider router, Node-based test scripts under `tools/scripts`.

---

## File Structure

- Modify `src/providers.mjs`: replace `briefUtilityComposer` with `guidanceComposer`; add schema mapping for `recursion.guidanceComposer.v1`; update provider role diagnostics.
- Modify `src/prompt.mjs`: introduce prompt packet V3, guidance validation, raw card evidence serialization, guidance composer request/response handling, and new prompt block ids.
- Modify `src/rapid-pipeline.mjs`: bump Rapid pipeline version to 2; replace `conditionedSceneBrief` with warm guidance metadata; define `rapidTurnDelta.v2`; remove quality-path fast-start brief schemas.
- Modify `src/runtime.mjs`: call guidance composer for Standard; save Rapid warm V2 artifacts; pass raw selected cards to Rapid foreground; escalate Rapid warm misses to Standard.
- Modify `src/storage.mjs`: sanitize and persist Rapid V2 warm artifact metadata and card packet diagnostics.
- Modify `src/ui.mjs`: expose card packet guidance status and raw card evidence in Last Brief/Prompt Packet/Viewer surfaces.
- Modify `tools/scripts/test-prompt.mjs`: cover packet V3, guidance composer validation, raw-card-only fallback, and raw card preservation.
- Modify `tools/scripts/test-rapid-pipeline.mjs`: cover Rapid V2 artifact validation and `rapidTurnDelta.v2` normalization.
- Modify `tools/scripts/test-runtime.mjs`: cover Standard guidance composer calls, Rapid warm V2, warm foreground packet assembly, and warm miss escalation.
- Modify `tools/scripts/test-storage.mjs`: cover Rapid V2 persistence and stale V1 invalidation.
- Modify `tools/scripts/test-ui.mjs`: cover prompt packet surface labels, guidance status, and full raw card text display.
- Modify docs listed in the design spec after code behavior is green.

## Task 1: Provider Role Contract

**Files:**
- Modify: `src/providers.mjs`
- Test: `tools/scripts/test-providers.mjs` if present, otherwise add assertions to the closest provider-routing test already covering role schemas

- [ ] **Step 1: Write failing provider role test**

Add assertions proving `guidanceComposer` is a Utility role and `briefUtilityComposer` is no longer in the role list.

```js
assert(UTILITY_ROLE_IDS.includes('guidanceComposer'), 'guidance composer is a Utility provider role');
assert(!UTILITY_ROLE_IDS.includes('briefUtilityComposer'), 'old brief utility composer role is removed');
assertEqual(roleResponseSchema('guidanceComposer'), 'recursion.guidanceComposer.v1', 'guidance composer schema is registered');
```

If `roleResponseSchema` is not exported, test through the provider request validation path that currently rejects unknown role schemas.

- [ ] **Step 2: Run failing provider test**

Run the focused provider test command used by this repo. If no dedicated script exists, run:

```powershell
node tools\scripts\test-providers.mjs
```

Expected: FAIL because `guidanceComposer` is not registered.

- [ ] **Step 3: Update provider registry**

In `src/providers.mjs`, replace:

```js
'briefUtilityComposer',
```

with:

```js
'guidanceComposer',
```

Replace schema mapping:

```js
briefUtilityComposer: 'recursion.briefUtilityComposer.v1',
```

with:

```js
guidanceComposer: 'recursion.guidanceComposer.v1',
```

Update any display labels from `Utility composer` or `briefUtilityComposer` to `Guidance composer` and `guidanceComposer`.

- [ ] **Step 4: Run provider test**

Run:

```powershell
node tools\scripts\test-providers.mjs
```

Expected: PASS.

## Task 2: Prompt Packet V3 Raw Card Evidence Tests

**Files:**
- Modify: `tools/scripts/test-prompt.mjs`
- Modify: `src/prompt.mjs`

- [ ] **Step 1: Add failing Standard packet test**

Add a hand with five cards: `Scene Frame`, `Active Cast`, `Scene Constraints`, `Social Subtext`, and `Open Threads`. Use long `promptText` values with unique markers:

```js
const markerHand = {
  handId: 'raw-card-hand',
  cards: [
    { id: 'scene-card', family: 'Scene Frame', promptText: 'SCENE_FRAME_MARKER full office pressure and escort boundary.', tokenEstimate: 20, evidenceRefs: ['message:913'] },
    { id: 'cast-card', family: 'Active Cast', promptText: 'ACTIVE_CAST_MARKER Dumbledore holds authority, Hermione guides, Rhya is fatigued.', tokenEstimate: 20, evidenceRefs: ['message:915'] },
    { id: 'constraint-card', family: 'Scene Constraints', promptText: 'SCENE_CONSTRAINT_MARKER Rhya cannot leave until escorted; breach was one-time and patched.', tokenEstimate: 20, evidenceRefs: ['message:916'] },
    { id: 'subtext-card', family: 'Social Subtext', promptText: 'SOCIAL_SUBTEXT_MARKER courtesy functions as protective control and veiled pressure.', tokenEstimate: 20, evidenceRefs: ['message:918'] },
    { id: 'thread-card', family: 'Open Threads', promptText: 'OPEN_THREADS_MARKER rest request closes the exchange and moves toward Gryffindor escort.', tokenEstimate: 20, evidenceRefs: ['message:923'] }
  ],
  omitted: []
};
```

Compose with a fake `generationRouter.generate('guidanceComposer', ...)` returning valid guidance:

```js
const guidanceCalls = [];
const packet = await composePromptPacket({
  hand: markerHand,
  snapshot: baseSnapshot(),
  settings: { promptFootprint: 'normal', reasonerUse: 'off' },
  generationRouter: {
    async generate(roleId, request) {
      guidanceCalls.push({ roleId, request });
      return {
        ok: true,
        data: {
          schema: 'recursion.guidanceComposer.v1',
          snapshotHash: hashJson(baseSnapshot()),
          guidanceText: 'GUIDANCE_MARKER play the escort beat as protective calm with visible control.',
          sourceCardIds: markerHand.cards.map((card) => card.id),
          guardrailCardIds: ['constraint-card'],
          omittedCardIds: [],
          diagnostics: ['guidance-ok']
        }
      };
    }
  }
});
```

Assert:

```js
assertEqual(packet.packetVersion, 3, 'packet v3 is used');
assert(packet.sections.guidance.includes('GUIDANCE_MARKER'), 'provider guidance is injected');
assert(packet.sections.cardEvidence.includes('SCENE_FRAME_MARKER'), 'raw Scene Frame survives');
assert(packet.sections.cardEvidence.includes('ACTIVE_CAST_MARKER'), 'raw Active Cast survives');
assert(packet.sections.cardEvidence.includes('SCENE_CONSTRAINT_MARKER'), 'raw Scene Constraints survives');
assert(packet.sections.cardEvidence.includes('SOCIAL_SUBTEXT_MARKER'), 'raw Social Subtext survives');
assert(packet.sections.cardEvidence.includes('OPEN_THREADS_MARKER'), 'raw Open Threads survives');
assert(!packet.sections.guidance.includes('Strength:'), 'behavior policy prose is not injected as guidance');
assert(!JSON.stringify(packet.sections).includes('Scene brief:'), 'old scene brief header is removed');
assertEqual(guidanceCalls[0].roleId, 'guidanceComposer', 'guidance composer provider role is called');
assert(guidanceCalls[0].request.prompt.includes('SOCIAL_SUBTEXT_MARKER'), 'guidance composer sees full raw cards');
```

- [ ] **Step 2: Run failing prompt test**

Run:

```powershell
node tools\scripts\test-prompt.mjs
```

Expected: FAIL because packet v3 and guidance sections do not exist.

## Task 3: Prompt Packet V3 Implementation

**Files:**
- Modify: `src/prompt.mjs`
- Test: `tools/scripts/test-prompt.mjs`

- [ ] **Step 1: Replace section keys**

Change:

```js
const SECTION_KEYS = Object.freeze(['sceneBrief', 'turnBrief', 'guardrails']);
```

to:

```js
const SECTION_KEYS = Object.freeze(['guidance', 'cardEvidence', 'guardrails']);
```

Change prompt packet version:

```js
export const PROMPT_PACKET_VERSION = 3;
```

Replace injection template with:

```js
const INJECTION_TEMPLATE = Object.freeze([
  Object.freeze({ id: 'guidance', promptKey: 'recursion.guidance', title: 'Recursion Guidance', placement: 'in_prompt', depth: 1, role: 'system' }),
  Object.freeze({ id: 'cardEvidence', promptKey: 'recursion.cardEvidence', title: 'Recursion Card Evidence', placement: 'in_prompt', depth: 1, role: 'system' }),
  Object.freeze({ id: 'guardrails', promptKey: 'recursion.guardrails', title: 'Recursion Guardrails', placement: 'in_prompt', depth: 1, role: 'system' })
]);
```

- [ ] **Step 2: Add raw card evidence serializer**

Add a serializer that groups without rewriting:

```js
function cardEvidenceLine(card) {
  const emphasis = card.emphasis === 'normal' ? '' : ` ${card.emphasis}`;
  return `- [${card.family || 'Card'}${emphasis}] ${card.promptText}`;
}

function buildCardEvidenceSection(cards) {
  const lines = ['Card evidence:'];
  for (const card of cards) {
    lines.push(cardEvidenceLine(card));
  }
  return {
    text: lines.join('\n'),
    sourceIds: cards.map((card) => card.id)
  };
}
```

This function serializes only. It must not summarize, merge, or truncate `promptText`.

- [ ] **Step 3: Add guidance composer prompt**

Add:

```js
const GUIDANCE_SCHEMA = 'recursion.guidanceComposer.v1';

function buildGuidancePrompt({ runId, snapshotHash: sourceSnapshotHash, cards, behaviorPolicy = null }) {
  return [
    'Write Recursion response guidance for the next story generation.',
    `Return one JSON object only using schema "${GUIDANCE_SCHEMA}".`,
    'Use the selected raw cards as evidence. Preserve their nuance, subtext, hard constraints, and response posture.',
    'Do not summarize the cards as a replacement; raw cards will be injected separately.',
    'Do not invent hidden motives, future plot, unrevealed facts, or out-of-character analysis.',
    'Expected JSON shape: {"schema":"recursion.guidanceComposer.v1","snapshotHash":"same snapshot hash","guidanceText":"provider-authored direction","sourceCardIds":["card-id"],"guardrailCardIds":["card-id"],"omittedCardIds":[{"id":"card-id","reason":"duplicate | lower-priority | unsupported | unsafe"}],"diagnostics":["safe-note"]}.',
    `Run id: ${runId}`,
    `Snapshot hash: ${sourceSnapshotHash}`,
    `Behavior policy:\n${behaviorComposerLines(behaviorPolicy).join('\n')}`,
    `Selected raw cards:\n${JSON.stringify(cards.map((card) => reasonerCard(card)), null, 2)}`
  ].join('\n\n');
}
```

- [ ] **Step 4: Validate guidance result**

Add validation mirroring existing Reasoner validation, but for `guidanceComposer`. It must return `{ ok, guidanceText, sourceCardIds, guardrailCardIds, omittedCardIds, diagnostics }` or `{ ok: false, reason }`.

Accepted omission reasons:

```js
const VALID_GUIDANCE_DROP_REASONS = new Set(['duplicate', 'lower-priority', 'unsupported', 'unsafe']);
```

Reject if schema mismatch, snapshot mismatch, empty `guidanceText`, hidden-thought wording, or invalid source ids only. Drop invalid optional ids and count them.

- [ ] **Step 5: Compose packet with guidance plus raw evidence**

In `composePromptPacket(...)`, build raw evidence first, then call `generationRouter.generate('guidanceComposer', ...)` when a router exists. If guidance is valid, install it. If invalid or unavailable, set guidance text to:

```text
Guidance unavailable; use the raw Recursion card evidence directly.
```

This is a minimal wrapper, not semantic composition.

Sections become:

```js
sections: {
  guidance: guidanceSectionText,
  cardEvidence: evidence.text,
  guardrails: 'Guardrails:\n- Honor player intent, visible facts, reveal boundaries, and hard card constraints.'
}
```

- [ ] **Step 6: Run prompt test**

Run:

```powershell
node tools\scripts\test-prompt.mjs
```

Expected: PASS.

## Task 4: Raw-Only Fallback And Invalid Guidance Tests

**Files:**
- Modify: `tools/scripts/test-prompt.mjs`
- Modify: `src/prompt.mjs`

- [ ] **Step 1: Add invalid guidance test**

Use a fake router returning wrong schema:

```js
const rawOnlyPacket = await composePromptPacket({
  hand: markerHand,
  snapshot: baseSnapshot(),
  settings: { promptFootprint: 'normal', reasonerUse: 'off' },
  generationRouter: {
    async generate() {
      return { ok: true, data: { schema: 'wrong.schema', guidanceText: 'BAD_GUIDANCE' } };
    }
  }
});

assert(rawOnlyPacket.sections.cardEvidence.includes('SOCIAL_SUBTEXT_MARKER'), 'raw evidence remains after guidance failure');
assert(!rawOnlyPacket.sections.guidance.includes('BAD_GUIDANCE'), 'invalid guidance is not injected');
assertEqual(rawOnlyPacket.diagnostics.guidanceStatus, 'fallback-raw-only', 'fallback status recorded');
```

- [ ] **Step 2: Add provider unavailable test**

Use no router:

```js
const noRouterPacket = await composePromptPacket({
  hand: markerHand,
  snapshot: baseSnapshot(),
  settings: { promptFootprint: 'normal', reasonerUse: 'off' }
});

assert(noRouterPacket.sections.cardEvidence.includes('SCENE_CONSTRAINT_MARKER'), 'raw evidence installs without guidance router');
assertEqual(noRouterPacket.diagnostics.guidanceStatus, 'missing', 'missing guidance status recorded');
```

- [ ] **Step 3: Run failing test**

Run:

```powershell
node tools\scripts\test-prompt.mjs
```

Expected: FAIL until diagnostics and fallback states are implemented.

- [ ] **Step 4: Implement diagnostics**

In packet diagnostics, add:

```js
guidanceStatus: 'used' | 'missing' | 'fallback-raw-only',
guidanceFallbackReason: '',
guidanceInvalidSourceIdCount: 0
```

Populate these from guidance validation.

- [ ] **Step 5: Run prompt test**

Run:

```powershell
node tools\scripts\test-prompt.mjs
```

Expected: PASS.

## Task 5: Rapid Pipeline V2 Schema Tests

**Files:**
- Modify: `tools/scripts/test-rapid-pipeline.mjs`
- Modify: `src/rapid-pipeline.mjs`

- [ ] **Step 1: Add Rapid V2 artifact usability test**

Create artifact:

```js
const rapidV2 = {
  pipelineVersion: 2,
  status: 'ready',
  warmArtifactId: 'rapid-warm-v2',
  baseSourceRevisionHash: 'base-rev',
  baseSnapshotHash: 'base-snapshot',
  selectedCardIds: ['scene-card', 'subtext-card'],
  cardIds: ['scene-card', 'subtext-card', 'constraint-card'],
  guidance: {
    schema: 'recursion.guidanceComposer.v1',
    status: 'used',
    text: 'Warm provider guidance.',
    sourceCardIds: ['scene-card', 'subtext-card'],
    guardrailCardIds: ['constraint-card'],
    diagnostics: []
  },
  settingsHash: 'settings',
  providerContractHash: 'provider',
  cardCatalogHash: 'catalog',
  promptContractHash: 'prompt',
  builtAt: '2026-07-03T00:00:00.000Z',
  runId: 'rapid-run',
  diagnostics: ['rapid-warm-v2']
};

const expectedRapidV2 = {
  baseSourceRevisionHash: 'base-rev',
  settingsHash: 'settings',
  providerContractHash: 'provider',
  cardCatalogHash: 'catalog',
  promptContractHash: 'prompt'
};

assert(rapidWarmArtifactIsUsable(rapidV2, expectedRapidV2), 'Rapid V2 warm artifact is usable');
assert(!rapidWarmArtifactIsUsable({ ...rapidV2, conditionedSceneBrief: 'old brief', pipelineVersion: 1 }, expectedRapidV2), 'Rapid V1 conditionedSceneBrief artifact is invalid');
```

- [ ] **Step 2: Add rapidTurnDelta.v2 normalization test**

```js
const normalized = normalizeRapidTurnDelta({
  schema: 'recursion.rapidTurnDelta.v2',
  snapshotHash: 'turn',
  baseSourceRevisionHash: 'base',
  turnSourceRevisionHash: 'turn-rev',
  selectedCardIds: ['scene-card', 'unknown-card'],
  turnGuidanceText: 'Use Rhya rest boundary as current beat close.',
  guardrailCardIds: ['constraint-card'],
  packetInstructions: ['Keep Hermione as escort.'],
  backgroundRefreshRequests: [],
  mandatoryMissingCards: [],
  escalateToStandard: false,
  diagnostics: ['delta-v2']
}, {
  snapshotHash: 'turn',
  baseSourceRevisionHash: 'base',
  turnSourceRevisionHash: 'turn-rev',
  allowedCardIds: ['scene-card', 'constraint-card']
});

assertDeepEqual(normalized.selectedCardIds, ['scene-card'], 'unknown card id is rejected');
assertEqual(normalized.turnGuidanceText, 'Use Rhya rest boundary as current beat close.', 'turn guidance preserved');
assertDeepEqual(normalized.guardrailCardIds, ['constraint-card'], 'guardrail card ids preserved');
```

- [ ] **Step 3: Run failing Rapid pipeline test**

Run:

```powershell
node tools\scripts\test-rapid-pipeline.mjs
```

Expected: FAIL because Rapid V2 schema is absent.

## Task 6: Rapid Pipeline V2 Implementation

**Files:**
- Modify: `src/rapid-pipeline.mjs`
- Test: `tools/scripts/test-rapid-pipeline.mjs`

- [ ] **Step 1: Bump version and schema**

Change:

```js
export const RAPID_PIPELINE_VERSION = 2;
export const RAPID_TURN_DELTA_SCHEMA = 'recursion.rapidTurnDelta.v2';
```

Remove V1 `conditionedSceneBrief` requirement from `rapidWarmArtifactIsUsable`. Require:

```js
Array.isArray(source.selectedCardIds)
  && source.selectedCardIds.length > 0
  && asObject(source.guidance).schema === 'recursion.guidanceComposer.v1'
  && Boolean(cleanText(asObject(source.guidance).text, TEXT_LIMIT))
```

- [ ] **Step 2: Update turn delta prompt**

Change prompt copy from "warm provider-generated scene guidance" to:

```text
Given the warm provider-authored guidance, full selected raw cards, and the latest user message, select the cards and write turn guidance for this reply.
```

Required fields must name `turnGuidanceText`, not `turnDeltaBrief`.

- [ ] **Step 3: Update normalization**

In `normalizeRapidTurnDelta`, read:

```js
turnGuidanceText: firstText([source.turnGuidanceText, source.turnDeltaBrief, source.turnBrief, brief.turnGuidanceText, brief.turnBrief], TEXT_LIMIT),
guardrailCardIds: cleanList(source.guardrailCardIds, 180, 20).filter((cardId) => allowed.has(cardId)),
```

Keep aliases only inside normalizer during implementation if tests need fixture migration; do not document old fields as current contract.

- [ ] **Step 4: Update artifact hash**

Hash `guidance` and `selectedCardIds`; stop hashing `conditionedSceneBrief`.

```js
return hashJson({
  version: RAPID_PIPELINE_VERSION,
  warmArtifactId: artifact.warmArtifactId,
  baseSourceRevisionHash: artifact.baseSourceRevisionHash,
  selectedCardIds: artifact.selectedCardIds,
  cardIds: artifact.cardIds,
  guidance: artifact.guidance
});
```

- [ ] **Step 5: Run Rapid pipeline test**

Run:

```powershell
node tools\scripts\test-rapid-pipeline.mjs
```

Expected: PASS.

## Task 7: Standard Runtime Guidance Composer

**Files:**
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `src/runtime.mjs`
- Test: `tools/scripts/test-runtime.mjs`

- [ ] **Step 1: Add Standard runtime test**

In a Standard send test with generated cards, make router capture calls:

```js
const routerCalls = [];
const generationRouter = {
  async generate(roleId, request) {
    routerCalls.push({ roleId, request });
    if (roleId === 'utilityArbiter') {
      return {
        ok: true,
        data: {
          schema: UTILITY_ARBITER_SCHEMA,
          snapshotHash: request.snapshotHash,
          action: 'refresh-cards',
          sceneStatus: 'same-scene',
          promptFootprint: 'normal',
          cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Unit scene card.' }],
          reasonerDecision: { mode: 'skip', reason: 'unit standard guidance test', signals: [] },
          budgets: { targetBriefTokens: 500, maxCards: 4 },
          diagnostics: ['standard-guidance-test']
        }
      };
    }
    if (roleId === 'sceneFrameCard') {
      return {
        ok: true,
        roleId,
        data: {
          schema: 'recursion.card.v1',
          role: 'sceneFrameCard',
          family: 'Scene Frame',
          snapshotHash: request.snapshotHash,
          items: [{
            promptText: 'raw card marker from scene frame provider.',
            evidenceRefs: ['message:2'],
            tokenEstimate: 12
          }]
        }
      };
    }
    if (roleId === 'guidanceComposer') {
      return {
        ok: true,
        data: {
          schema: 'recursion.guidanceComposer.v1',
          snapshotHash: request.snapshotHash,
          guidanceText: 'STANDARD_GUIDANCE_MARKER use raw cards as evidence.',
          sourceCardIds: ['scene-card'],
          guardrailCardIds: [],
          omittedCardIds: [],
          diagnostics: ['standard-guidance']
        }
      };
    }
    throw new Error(`unexpected role ${roleId}`);
  }
};
```

Assert:

```js
assert(routerCalls.some((call) => call.roleId === 'guidanceComposer'), 'Standard calls guidance composer');
assert(view.lastPacket.sections.guidance.includes('STANDARD_GUIDANCE_MARKER'), 'Standard installs guidance');
assert(view.lastPacket.sections.cardEvidence.includes('raw card marker'), 'Standard installs raw cards');
```

- [ ] **Step 2: Run failing runtime test**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: FAIL because runtime/prompt path does not call `guidanceComposer`.

- [ ] **Step 3: Pass router through prompt composition**

The existing Standard path already passes `generationRouter` into `composePromptPacket(...)`. After Task 3, ensure the router is signal-aware and calls `guidanceComposer` before packet install. Remove old `reasonerComposer` patch dependency from normal guidance path or update tests so Reasoner is a guidance lane, not a raw-card replacement.

- [ ] **Step 4: Run runtime test**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: PASS for Standard guidance behavior.

## Task 8: Rapid Warm V2 Runtime

**Files:**
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `src/runtime.mjs`
- Modify: `src/storage.mjs`
- Test: `tools/scripts/test-runtime.mjs`, `tools/scripts/test-storage.mjs`

- [ ] **Step 1: Add Rapid warm V2 runtime test**

Trigger Rapid warm and assert:

```js
assertEqual(cache.active.rapid.pipelineVersion, 2, 'Rapid warm artifact uses v2');
assert(cache.active.rapid.guidance.text.includes('GUIDANCE_MARKER'), 'Rapid warm stores provider guidance');
assertDeepEqual(cache.active.rapid.selectedCardIds, view.lastHand.cards.map((card) => card.id), 'Rapid warm stores selected card ids');
assert(!Object.prototype.hasOwnProperty.call(cache.active.rapid, 'conditionedSceneBrief'), 'Rapid warm no longer stores conditionedSceneBrief');
```

- [ ] **Step 2: Run failing tests**

Run:

```powershell
node tools\scripts\test-runtime.mjs
node tools\scripts\test-storage.mjs
```

Expected: FAIL because Rapid warm still writes `conditionedSceneBrief`.

- [ ] **Step 3: Update Rapid warm construction**

In `warmRapidScene(...)`, delete `conditionedSceneBrief` construction. After `hand = selectHand(...)`, call the same guidance composition helper used by Standard, but do not install prompt keys. Save:

```js
const rapid = {
  pipelineVersion: RAPID_PIPELINE_VERSION,
  status: 'ready',
  warmArtifactId: makeId('rapid-warm-artifact'),
  baseSourceRevisionHash: activeSourceRevisionHash(snapshot),
  baseSnapshotHash: hashJson(snapshot),
  selectedCardIds: hand.cards.map((card) => card.id),
  cardIds: deck.cards.map((card) => card.id),
  guidance: guidanceForWarmArtifact,
  ...cacheContractVersions(settings),
  builtAt: nowIso(),
  runId,
  diagnostics: mergeDiagnostics(plan.diagnostics, [`rapid-warm-v2:${safeText(reason, 80)}`])
};
```

Ensure `guidanceForWarmArtifact.text` comes from provider output or records missing/fallback state. It must not be built from joined card text.

- [ ] **Step 4: Update storage sanitizer**

In `src/storage.mjs`, replace `conditionedSceneBrief` sanitizer with a `guidance` object sanitizer and `selectedCardIds` list sanitizer.

- [ ] **Step 5: Run tests**

Run:

```powershell
node tools\scripts\test-runtime.mjs
node tools\scripts\test-storage.mjs
```

Expected: PASS for Rapid warm V2 tests.

## Task 9: Rapid Foreground V2 And Warm Miss Escalation

**Files:**
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `src/runtime.mjs`
- Test: `tools/scripts/test-runtime.mjs`

- [ ] **Step 1: Add Rapid foreground raw-card test**

With a valid Rapid V2 warm artifact and cached cards, send a user message. Capture `rapidTurnDelta` request:

```js
assert(rapidTurnDeltaRequest.prompt.includes('SOCIAL_SUBTEXT_MARKER'), 'Rapid foreground receives full raw selected cards');
assert(rapidTurnDeltaRequest.prompt.includes('Warm provider guidance'), 'Rapid foreground receives warm guidance');
```

Assert installed packet:

```js
assert(view.lastPacket.sections.guidance.includes('Warm provider guidance'), 'Rapid packet includes warm guidance');
assert(view.lastPacket.sections.guidance.includes('TURN_GUIDANCE_MARKER'), 'Rapid packet includes turn guidance');
assert(view.lastPacket.sections.cardEvidence.includes('SOCIAL_SUBTEXT_MARKER'), 'Rapid packet includes full raw card evidence');
assertEqual(view.lastPacket.diagnostics.rapidPath, 'warm-v2', 'Rapid warm-v2 path recorded');
```

- [ ] **Step 2: Add warm miss escalation test**

Set `pipelineMode: 'rapid'` with no usable warm artifact. Assert:

```js
assert(routerCalls.some((call) => call.roleId === 'utilityArbiter'), 'warm miss runs Standard arbiter');
assert(!routerCalls.some((call) => call.roleId === 'rapidFastStartPack'), 'warm miss does not use summary fast-start');
assert(view.lastPacket.diagnostics.pipelineMode === 'standard', 'warm miss installs Standard packet');
assert(view.lastPlan.diagnostics.includes('rapid-warm-miss-standard'), 'warm miss diagnostic recorded');
```

- [ ] **Step 3: Run failing runtime test**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: FAIL because Rapid foreground still uses V1 fields and fast-start.

- [ ] **Step 4: Update Rapid foreground request**

Pass full raw selected cards into `buildRapidTurnDeltaPrompt(...)`:

```js
selectedCards: candidateCards
  .filter((card) => rapid.selectedCardIds.includes(card.id))
  .map((card) => ({
    id: card.id,
    family: card.family,
    promptText: card.promptText,
    emphasis: card.emphasis,
    detailProfile: card.detailProfile,
    evidenceRefs: card.evidenceRefs
  }))
```

Pass `warmGuidance: rapid.guidance`.

- [ ] **Step 5: Replace Rapid packet assembly**

Use the same packet V3 builder as Standard, with:

- guidance text = warm guidance + `turnGuidanceText`;
- card evidence = selected cards from `rapidTurnDelta.v2`;
- guardrails = minimal wrapper plus selected guardrail ids;
- diagnostics `pipelineMode: 'rapid'`, `rapidPath: 'warm-v2'`.

- [ ] **Step 6: Remove fast-start quality path**

When `usableWarm` is false, return escalation:

```js
return {
  ok: false,
  escalateToStandard: true,
  diagnostics: ['rapid-warm-miss-standard']
};
```

Ensure Standard then runs with the same pending user message.

- [ ] **Step 7: Run runtime test**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: PASS for Rapid foreground V2 and warm miss escalation.

## Task 10: UI And Inspection Contract

**Files:**
- Modify: `tools/scripts/test-ui.mjs`
- Modify: `src/ui.mjs`

- [ ] **Step 1: Add UI test for packet V3**

Build a `lastPacket` fixture:

```js
const packetV3 = {
  packetVersion: 3,
  sections: {
    guidance: 'Guidance:\n- GUIDANCE_UI_MARKER',
    cardEvidence: 'Card evidence:\n- [Social Subtext] SOCIAL_SUBTEXT_UI_MARKER',
    guardrails: 'Guardrails:\n- Honor player intent.'
  },
  diagnostics: {
    guidanceStatus: 'used',
    pipelineMode: 'rapid',
    rapidPath: 'warm-v2'
  },
  selectedCardRefs: [{ cardId: 'subtext-card', family: 'Social Subtext', emphasis: 'normal', tokenEstimate: 20, detailProfile: 'standard', evidenceRefs: ['message:918'] }]
};
```

Assert Prompt Packet/Viewer surfaces show `GUIDANCE_UI_MARKER`, `SOCIAL_SUBTEXT_UI_MARKER`, `guidance: used`, and `rapid warm-v2`.

- [ ] **Step 2: Run failing UI test**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: FAIL because UI expects old scene/turn brief sections.

- [ ] **Step 3: Update UI section rendering**

Update prompt packet rendering to iterate `guidance`, `cardEvidence`, and `guardrails`. Preserve full raw card text expansion rules: no line clamp, no per-card scroll, parent list owns scrolling.

- [ ] **Step 4: Run UI test**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: PASS.

## Task 11: Documentation Rewrite

**Files:**
- Modify: `docs/technical/PROMPT_PACKET_AND_INJECTION.md`
- Modify: `docs/architecture/PROMPT_COMPOSITION_SPEC.md`
- Modify: `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`
- Modify: `docs/architecture/RUNTIME_ARCHITECTURE.md`
- Modify: `docs/user/RECURSION_OPERATOR_MANUAL.md`
- Modify: `docs/user/FIRST_RUN_WORKFLOW.md`
- Modify: `docs/design/UI_SPEC.md`
- Modify: `docs/release/0.1.0-pre-alpha.1.md`

- [ ] **Step 1: Update prompt packet docs**

Replace "Recursion injects a composed packet, not the full raw scene deck" with:

```markdown
Recursion injects a card packet: provider-authored guidance plus full raw selected card evidence. Guidance directs how to use the cards; raw cards remain the source of truth.
```

Document prompt blocks:

```markdown
| Guidance | `recursion.guidance` | Provider-authored direction for using selected cards. |
| Card Evidence | `recursion.cardEvidence` | Full raw selected card prompt text grouped by family. |
| Guardrails | `recursion.guardrails` | Minimal global wrapper plus hard card-constraint priority. |
```

- [ ] **Step 2: Update Rapid docs**

Replace all claims that Rapid stores `conditionedSceneBrief` with Rapid Warm V2 language:

```markdown
Rapid warms a card packet in the background: selected raw cards plus provider-authored guidance. On send, Rapid runs a foreground turn-delta call over the warm guidance, full selected cards, and latest user message.
```

Document warm miss:

```markdown
If no exact warm card packet exists, Rapid escalates to Standard for that turn. V1 summary-only fast-start is removed from the quality path.
```

- [ ] **Step 3: Update UI docs**

Document Prompt Packet inspection as guidance plus raw card evidence. Keep "Last Brief" only if the visible compact label remains unchanged in implementation.

- [ ] **Step 4: Run docs search**

Run:

```powershell
rg -n "conditionedSceneBrief|Scene brief|Turn brief|briefUtilityComposer|rapidFastStartPack|provider-generated scene guidance" docs src tools\scripts
```

Expected: Remaining hits are either compatibility-normalizer aliases, old plan/spec historical docs, or intentionally updated explanations.

## Task 12: Full Verification

**Files:**
- All modified files

- [ ] **Step 1: Run focused tests**

Run:

```powershell
node tools\scripts\test-prompt.mjs
node tools\scripts\test-rapid-pipeline.mjs
node tools\scripts\test-runtime.mjs
node tools\scripts\test-storage.mjs
node tools\scripts\test-ui.mjs
```

Expected: all PASS.

- [ ] **Step 2: Run broader gate**

Run the repo's current named gate if available:

```powershell
node tools\scripts\run-alpha-gate.mjs
```

Expected: PASS. If this script does not exist, run the documented equivalent test suite in `docs/testing/TESTING_STRATEGY.md`.

- [ ] **Step 3: Live prompt packet proof**

Use the SillyTavern Playwright harness for one dense turn. Confirm installed prompt packet contains:

- `recursion.guidance` with provider-authored guidance;
- `recursion.cardEvidence` with full raw selected cards;
- `recursion.guardrails` minimal wrapper;
- no `conditionedSceneBrief`;
- no local scene/turn brief substitute;
- Rapid warm V2 diagnostics when Rapid path is used.

- [ ] **Step 4: Final diff review**

Run:

```powershell
git diff -- src docs tools
```

Check:

- no deterministic semantic composer introduced;
- no raw card `promptText` truncation except absolute safety cap;
- no old `briefUtilityComposer` role remains in current contract;
- Rapid warm miss escalates Standard;
- docs match runtime behavior.

## Execution Notes

Implement in order. Do not preserve old prompt packet or Rapid artifact compatibility. Recursion is pre-alpha; update contracts in place.

Commit suggested checkpoints if requested:

1. `feat: add card packet prompt contract`
2. `feat: revise rapid warm pipeline`
3. `test: cover card packet pipelines`
4. `docs: update prompt packet pipeline docs`
