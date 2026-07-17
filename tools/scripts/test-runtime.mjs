import { cacheContractVersions, createRecursionRuntime, filterCardsForCardEligibility, filterPlanForCardEligibility, rapidWarmContractVersions } from '../../src/runtime.mjs';
import { createActivityReporter } from '../../src/activity.mjs';
import { createSettingsStore } from '../../src/settings.mjs';
import { createMemoryStorageAdapter, createStorageRepository } from '../../src/storage.mjs';
import { createGenerationRouter, createProviderClient } from '../../src/providers.mjs';
import { createRuntimeRunState } from '../../src/runtime/run-state.mjs';
import { clearPromptBestEffort, installPrompt } from '../../src/runtime/prompt-install.mjs';
import { runFusedCardPipeline } from '../../src/runtime/pipelines/fused.mjs';
import { runRapidForegroundPipeline, warmRapidPipeline } from '../../src/runtime/pipelines/rapid.mjs';
import { runStandardCardPipeline } from '../../src/runtime/pipelines/standard.mjs';
import { CARD_CATALOG, cardsFromProviderResult } from '../../src/cards.mjs';
import {
  CARD_SCOPE_CATALOG,
  defaultCardScope,
  manualSelectedFamilies,
  normalizeCardScope,
  setFamilyEnabled,
  setSubItemEnabled
} from '../../src/card-scope.mjs';
import { activeCardDeckRuntimeScope } from '../../src/card-decks.mjs';
import { packetToPromptBlocks } from '../../src/prompt.mjs';
import { createHeroPixelBlocks, createProgressRunModel } from '../../src/progress.mjs';
import { hashJson } from '../../src/core.mjs';
import { safeDiagnosticText, safeIdentifier, safeText, unsafeObjectString } from '../../src/safe-values.mjs';
import { UNKNOWN_STORY_FORM } from '../../src/story-form.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

const UTILITY_ARBITER_SCHEMA = 'recursion.utilityArbiter.v1';
assertEqual(safeText({ label: 'Visible', token: 'sk-live-secret' }).includes('[redacted]'), true, 'safeText redacts object secrets');
assertEqual(unsafeObjectString('[object Object]'), true, 'unsafe object marker is detected');
assertEqual(safeDiagnosticText('[object Object]'), '', 'unsafe object marker is removed from diagnostics text');
assertEqual(safeIdentifier(' Scene / Beat 1 '), 'scene-beat-1', 'safeIdentifier normalizes labels');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

async function waitUntil(predicate, message, { attempts = 50, delayMs = 0 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(message);
}

function delay(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function assertNoSecretText(value, label) {
  const serialized = JSON.stringify(value);
  assert(!/\bbearer\s+[a-z0-9._-]+/i.test(serialized), `${label} redacts bearer text`);
  assert(!/\bsk-[a-z0-9_-]+/i.test(serialized), `${label} redacts sk text`);
  assert(!/private[-_\s]*secret/i.test(serialized), `${label} redacts private secret text`);
  return serialized;
}

function assertNoObjectString(value, label) {
  const serialized = JSON.stringify(value);
  assert(!serialized.includes('[object Object]') && !serialized.includes('object-Object'), label);
}

function assertNotEqual(actual, expected, message) {
  if (actual === expected) {
    throw new Error(`${message}: did not expect ${expected}`);
  }
}

function runtimeHasOwnMethod(runtime, name) {
  return typeof runtime?.[name] === 'function';
}

{
  const runState = createRuntimeRunState();
  runState.setActiveRun('run-state-1', { abort() {} });
  assertEqual(runState.current().activeRunId, 'run-state-1', 'run state stores active run id');
  runState.setLatestAssistantSwipeRetry({ reason: 'latest-assistant-swipe' });
  assertEqual(runState.takeLatestAssistantSwipeRetry().reason, 'latest-assistant-swipe', 'run state takes swipe retry once');
  assertEqual(runState.takeLatestAssistantSwipeRetry(), null, 'swipe retry is cleared after take');
  runState.setFreshNextGeneration({ id: 'fresh-1' });
  assertEqual(runState.takeFreshNextGeneration().id, 'fresh-1', 'fresh next generation token is taken once');
  runState.clearActiveRun('run-state-1');
  assertEqual(runState.current().activeRunId, null, 'run state clears active run');
}

{
  const promptInstallCalls = [];
  const promptHost = {
    prompt: {
      async install(packet, options) {
        promptInstallCalls.push({ packet, options });
        return { ok: true, promptId: 'prompt-1' };
      },
      async clear(options) {
        promptInstallCalls.push({ clear: true, options });
        return { ok: true };
      }
    }
  };
  const install = await installPrompt(promptHost, { promptText: 'Prompt' });
  const clear = await clearPromptBestEffort(promptHost);
  assertEqual(promptInstallCalls.length, 2, 'prompt install helper calls clear and install');
  assertEqual(install.ok, true, 'prompt install helper preserves successful install result');
  assertEqual(clear.ok, true, 'prompt clear helper preserves successful clear result');
}

{
  const pipelineCalls = [];
  const pipelinePlan = {
    snapshotHash: 'pipeline-snapshot',
    storyForm: UNKNOWN_STORY_FORM,
    cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Pipeline helper test.' }]
  };
  const pipelineRequest = {
    roleId: 'sceneFrameCard',
    snapshotHash: 'pipeline-snapshot',
    lane: 'utility',
    metadata: { family: 'Scene Frame', role: 'sceneFrameCard' }
  };
  const pipelineSourceContext = {
    sceneId: 'pipeline-scene',
    chatId: 'pipeline-chat',
    firstMesId: 0,
    lastMesId: 2,
    snapshotHash: 'pipeline-snapshot',
    sourceRevisionHash: 'pipeline-source'
  };
  const standardResult = await runStandardCardPipeline({
    plan: pipelinePlan,
    snapshot: {},
    settings: { pipelineMode: 'standard' },
    requests: [pipelineRequest],
    sourceContext: pipelineSourceContext,
    generationRouter: {
      async generate(roleId) {
        pipelineCalls.push(`standard:${roleId}`);
        return {
          ok: true,
          lane: 'utility',
          data: {
            schema: 'recursion.card.v1',
            snapshotHash: 'pipeline-snapshot',
            family: 'Scene Frame',
            role: 'sceneFrameCard',
            items: [{
              family: 'Scene Frame',
              role: 'sceneFrameCard',
              promptText: 'Keep the pipeline test scene spatially coherent.',
              evidenceRefs: ['message:1']
            }]
          }
        };
      }
    }
  });
  assertEqual(standardResult.cards.length, 1, 'standard pipeline returns parsed card result');

  const fusedResult = await runFusedCardPipeline({
    plan: pipelinePlan,
    snapshot: {},
    settings: { pipelineMode: 'fused' },
    requests: [pipelineRequest],
    requestContext: {
      runId: 'pipeline-run',
      snapshotHash: 'pipeline-snapshot',
      snapshot: {},
      cardScope: {},
      storyForm: UNKNOWN_STORY_FORM
    },
    sourceContext: pipelineSourceContext,
    applyFusedRequest: (request) => ({ ...request, lane: 'utility' }),
    safeText,
    generationRouter: {
      async generate(roleId) {
        pipelineCalls.push(`fused:${roleId}`);
        return {
          ok: true,
          lane: 'utility',
          data: {
            schema: 'recursion.cardBundle.v1',
            snapshotHash: 'pipeline-snapshot',
            items: [{
              schema: 'recursion.card.v1',
              family: 'Scene Frame',
              role: 'sceneFrameCard',
              promptText: 'Use one recovered fused card from the helper test.',
              evidenceRefs: ['message:1']
            }]
          }
        };
      }
    }
  });
  assertEqual(fusedResult.cards.length, 1, 'fused pipeline returns parsed card result');
  assert(fusedResult.diagnostics.includes('fused-bundle-used'), 'fused pipeline preserves bundle diagnostic');
  assertDeepEqual(pipelineCalls, ['standard:sceneFrameCard', 'fused:fusedCardBundle'], 'standard and fused pipeline helpers call their matching provider roles');
}

{
  const rapidPipelineCalls = [];
  await warmRapidPipeline({
    reason: 'idle',
    snapshot: {},
    settings: { pipelineMode: 'rapid' },
    providerClient: {
      async generateRapidWarmDeck() {
        rapidPipelineCalls.push('warm');
        return { cards: [{ id: 'rapid-card' }] };
      }
    },
    storage: {
      async saveRapidWarm(result) {
        rapidPipelineCalls.push(`save-${result.cards.length}`);
      }
    },
    journal: () => {}
  });
  await runRapidForegroundPipeline({
    snapshot: {},
    settings: { pipelineMode: 'rapid' },
    warmDeck: { cards: [{ id: 'rapid-card' }] },
    providerClient: {
      async generateRapidTurnDelta() {
        rapidPipelineCalls.push('foreground');
        return { cards: [{ id: 'rapid-card' }] };
      }
    },
    journal: () => {}
  });
  assertDeepEqual(rapidPipelineCalls, ['warm', 'save-1', 'foreground'], 'rapid pipeline helpers run warm, save, and foreground paths');
}

function parsePromptJsonSection(prompt, label) {
  const prefix = `${label}: `;
  const section = String(prompt || '').split('\n\n').find((entry) => entry.startsWith(prefix));
  assert(section, `arbiter prompt includes ${label}`);
  return JSON.parse(section.slice(prefix.length));
}

function parseReasonerPromptSnapshotHash(prompt) {
  const match = /^Snapshot hash: (.+)$/m.exec(String(prompt || ''));
  assert(match, 'reasoner prompt includes snapshot hash');
  return match[1].trim();
}

function healthyReasonerSettings(settings = {}) {
  return {
    ...settings,
    providers: {
      ...(settings.providers || {}),
      reasoner: {
        enabled: true,
        lastTest: { status: 'pass' },
        ...(settings.providers?.reasoner || {})
      }
    }
  };
}

function cardProviderResponse(roleId, request = {}) {
  const catalog = CARD_CATALOG.find((entry) => entry.role === roleId) || CARD_CATALOG[0];
  return {
    ok: true,
    roleId,
    data: {
      schema: 'recursion.card.v1',
      role: catalog.role,
      family: catalog.family,
      snapshotHash: request.snapshotHash,
      items: [{
        promptText: `${catalog.family} card guidance for this turn.`,
        evidenceRefs: ['message:2'],
        tokenEstimate: 12
      }]
    }
  };
}

function sourceFingerprintForMessages(messages = [], firstMesId = null, lastMesId = null) {
  const first = Number.isFinite(Number(firstMesId)) ? Number(firstMesId) : Number.NEGATIVE_INFINITY;
  const last = Number.isFinite(Number(lastMesId)) ? Number(lastMesId) : Number.POSITIVE_INFINITY;
  return hashJson(messages
    .filter((message) => message?.visible !== false)
    .map((message) => ({
      mesid: Number(message.mesid) || 0,
      role: ['assistant', 'system', 'user'].includes(String(message.role || '').toLowerCase())
        ? String(message.role).toLowerCase()
        : 'assistant',
      textHash: String(message.textHash || hashJson(String(message.text ?? '')))
    }))
    .filter((message) => message.mesid >= first && message.mesid <= last));
}

function rapidWarmSnapshotFixture() {
  const text = 'The corridor ends at a sealed hatch.';
  const messages = [
    { mesid: 2, role: 'user', text, textHash: hashJson(text), visible: true }
  ];
  const baseSourceRevisionHash = sourceFingerprintForMessages(messages, 2, 2);
  return {
    baseSourceRevisionHash,
    snapshot: {
      chatId: 'rapid-chat',
      chatKey: 'rapid-chat',
      sceneKey: 'rapid-scene',
      sceneFingerprint: 'rapid-scene-fp',
      turnFingerprint: 'rapid-turn-fp',
      sourceRevisionHash: baseSourceRevisionHash,
      latestMesId: 2,
      messages
    }
  };
}

function rapidWarmCacheFixture({
  cardId = 'warm-card-1',
  baseSourceRevisionHash,
  firstMesId = 2,
  lastMesId = 2,
  evidenceRefs = ['message:2']
} = {}) {
  const rapidContracts = rapidWarmContractVersions({ pipelineMode: 'rapid', mode: 'auto' });
  return {
    cacheState: 'active',
    versions: cacheContractVersions({ pipelineMode: 'rapid', mode: 'auto' }),
    activeSourceRevisionHash: baseSourceRevisionHash,
    variantOrder: [baseSourceRevisionHash],
    variants: {
      [baseSourceRevisionHash]: {
        sourceRevisionHash: baseSourceRevisionHash,
        cards: [{
          id: cardId,
          family: 'Scene Constraints',
          role: 'sceneConstraintsCard',
          summary: 'The hatch stays sealed until opened.',
          promptText: 'The hatch stays sealed until opened.',
          evidenceRefs,
          source: {
            chatId: 'rapid-chat',
            firstMesId,
            lastMesId,
            fingerprint: baseSourceRevisionHash,
            snapshotHash: baseSourceRevisionHash,
            sourceRevisionHash: baseSourceRevisionHash
          },
          freshness: {
            sourceFingerprint: baseSourceRevisionHash,
            sourceRevisionHash: baseSourceRevisionHash
          }
        }],
        rapid: {
          pipelineVersion: 2,
          status: 'ready',
          warmArtifactId: 'rapid-warm-fixture',
          baseSourceRevisionHash,
          baseSnapshotHash: hashJson({ sourceRevisionHash: baseSourceRevisionHash }),
          selectedCardIds: [cardId],
          cardIds: [cardId],
          guidance: {
            schema: 'recursion.guidanceComposer.v1',
            status: 'used',
            text: 'Warm provider guidance.',
            sourceCardIds: [cardId],
            guardrailCardIds: [cardId],
            omittedCardIds: [],
            diagnostics: ['warm-guidance']
          },
          storyForm: {
            schema: 'recursion.storyForm.v1',
            tense: 'past',
            pov: 'third-person-limited',
            confidence: 'high',
            evidenceRefs,
            reason: 'Warm assistant narration establishes form.'
          },
          settingsHash: rapidContracts.settingsHash,
          providerContractHash: rapidContracts.providerContractHash,
          cardCatalogHash: rapidContracts.cardCatalogHash,
          promptContractHash: rapidContracts.promptContractHash,
          diagnostics: ['rapid-warm-ready']
        }
      }
    }
  };
}

function reasonerComposerResponse(request = {}, instructionPatch = 'Fuse the selected Recursion hand for this turn.') {
  return {
    ok: true,
    roleId: 'reasonerComposer',
    data: {
      schema: 'recursion.reasonerComposer.v1',
      snapshotHash: parseReasonerPromptSnapshotHash(request.prompt),
      instructionPatch,
      keptCardIds: [],
      droppedCardIds: []
    }
  };
}

function messageTextHash(message) {
  return hashJson(String(message?.text ?? message?.mes ?? message?.content ?? ''));
}

function sourceWindowHash(messages, firstMesId, lastMesId) {
  return hashJson((Array.isArray(messages) ? messages : [])
    .filter((message) => message?.visible !== false)
    .map((message, index) => {
      const swipeId = Number(message?.swipeId ?? message?.swipe_id);
      const swipeCount = Number(message?.swipeCount ?? (Array.isArray(message?.swipes) ? message.swipes.length : NaN));
      return {
        mesid: Number(message?.mesid ?? message?.id ?? message?.messageId ?? index),
        role: String(message?.role ?? (message?.is_user === true ? 'user' : (message?.is_system === true ? 'system' : 'assistant'))),
        textHash: String(message?.textHash || messageTextHash(message)),
        ...(Number.isFinite(swipeId) ? { swipeId } : {}),
        ...(Number.isFinite(swipeCount) ? { swipeCount } : {}),
        ...(message?.activeSwipeTextHash ? { activeSwipeTextHash: String(message.activeSwipeTextHash) } : {})
      };
    })
    .filter((message) => message.mesid >= firstMesId && message.mesid <= lastMesId));
}

function scopeWithFamilyDisabled(family) {
  return setFamilyEnabled(defaultCardScope(), family, false).scope;
}

function scopeWithOnlyFamilies(families) {
  const keep = new Set((Array.isArray(families) ? families : []).map((family) => String(family || '')));
  let scope = defaultCardScope();
  for (const entry of CARD_SCOPE_CATALOG) {
    if (!keep.has(entry.family)) scope = setFamilyEnabled(scope, entry.family, false).scope;
  }
  return scope;
}

function runtimeSnapshotHash(snapshot) {
  const messages = (Array.isArray(snapshot.messages) ? snapshot.messages : []).map((message, index) => ({
    mesid: Number(message?.mesid ?? message?.id ?? message?.messageId ?? index),
    role: String(message?.role ?? (message?.is_user === true ? 'user' : (message?.is_system === true ? 'system' : 'assistant'))),
    text: String(message?.text ?? message?.mes ?? message?.content ?? ''),
    textHash: String(message?.textHash || messageTextHash(message)),
    ...(Number.isFinite(Number(message?.swipeId ?? message?.swipe_id)) ? { swipeId: Number(message?.swipeId ?? message?.swipe_id) } : {}),
    ...(Number.isFinite(Number(message?.swipeCount ?? (Array.isArray(message?.swipes) ? message.swipes.length : NaN))) ? { swipeCount: Number(message?.swipeCount ?? (Array.isArray(message?.swipes) ? message.swipes.length : NaN)) } : {}),
    ...(message?.activeSwipeTextHash ? { activeSwipeTextHash: String(message.activeSwipeTextHash) } : {}),
    visible: message?.visible === false || message?.hidden === true ? false : true
  }));
  const latest = messages.at(-1);
  return hashJson({
    chatId: String(snapshot.chatId ?? snapshot.chatKey ?? 'chat'),
    chatKey: String(snapshot.chatKey ?? snapshot.chatId ?? 'chat'),
    sceneKey: String(snapshot.sceneKey ?? snapshot.sceneFingerprint ?? 'scene'),
    sceneFingerprint: String(snapshot.sceneFingerprint ?? hashJson(messages)),
    turnFingerprint: String(snapshot.turnFingerprint ?? hashJson({ latestMesId: snapshot.latestMesId ?? latest?.mesid ?? 0, messages: messages.slice(-3) })),
    latestMesId: Number(snapshot.latestMesId ?? latest?.mesid ?? 0),
    messages
  });
}

function swipeSnapshot({ text, swipeId, label = 'swipe' }) {
  const messages = [{
    mesid: 2,
    role: 'assistant',
    text,
    visible: true,
    swipeId,
    swipeCount: 2,
    activeSwipeTextHash: hashJson(text)
  }];
  const sourceRevisionHash = sourceWindowHash(messages, 2, 2);
  return {
    chatId: 'swipe-runtime-chat',
    chatKey: 'swipe-runtime-chat',
    sceneKey: 'swipe-runtime-scene',
    sceneFingerprint: 'swipe-runtime-scene-fp',
    turnFingerprint: hashJson({ label, swipeId, sourceRevisionHash }),
    sourceRevisionHash,
    latestMesId: 2,
    messages
  };
}

function createProseMessageHarness(initialText = 'She was angry. "Keep the door shut," Mara said.') {
  const calls = [];
  const message = {
    chatKey: 'prose-runtime-chat',
    messageId: 8,
    swipeId: 0,
    text: initialText,
    heldText: null,
    swipes: [initialText],
    originalHash: hashJson(initialText)
  };
  return {
    message,
    calls,
    messages: {
      activeAssistantMessageIdentity() {
        return { ...message };
      },
      async holdAssistantMessage(messageId) {
        calls.push({ type: 'hold', messageId });
        message.heldText = message.text;
        message.text = '';
        message.swipes[message.swipeId] = '';
        return { ok: true };
      },
      async revealAssistantMessage(messageId) {
        calls.push({ type: 'reveal', messageId });
        if (message.heldText !== null) {
          message.text = message.heldText;
          message.swipes[message.swipeId] = message.heldText;
          message.heldText = null;
        }
        return { ok: true };
      },
      async replaceAssistantMessageText(messageId, text, options = {}) {
        calls.push({ type: 'replace', messageId, text, options });
        message.text = text;
        message.swipes[message.swipeId] = text;
        message.heldText = null;
        return { ok: true, text };
      },
      async appendAssistantMessageSwipe(messageId, text, options = {}) {
        calls.push({ type: 'append', messageId, text, options });
        message.swipes.push(text);
        message.text = text;
        message.swipeId = message.swipes.length - 1;
        message.heldText = null;
        return { ok: true, index: 1, text };
      },
      async findEnhancedSwipe(messageId, marker = {}) {
        calls.push({ type: 'find', messageId, marker });
        return null;
      }
    }
  };
}

function isAbortSignal(value) {
  return Boolean(value)
    && typeof value.aborted === 'boolean'
    && typeof value.addEventListener === 'function'
    && typeof value.removeEventListener === 'function';
}

function createRuntimeHarness({
  settings = {},
  snapshot = null,
  hostPrompt = {},
  hostGeneration = {},
  hostMessages = {},
  generationRouter = undefined,
  activity = createActivityReporter(),
  storage: providedStorage = null,
  rapidHedgeDelayMs = undefined,
  rapidWarmJoinWaitMs = undefined
} = {}) {
  const calls = {
    snapshot: 0,
    install: 0,
    clear: 0
  };
  const installed = [];
  const cleared = [];
  const adapter = createMemoryStorageAdapter();
  const storage = providedStorage || createStorageRepository({ storage: adapter });
  const settingsStore = createSettingsStore({ root: {} });
  settingsStore.update(settings);
  const resolvedGenerationRouter = generationRouter === undefined ? localFallbackCardRouter() : generationRouter;
  const host = {
    async snapshot() {
      calls.snapshot += 1;
      if (typeof snapshot === 'function') return clone(await snapshot());
      return clone(snapshot ?? {
        chatId: 'chat-1',
        chatKey: 'chat-1',
        sceneKey: 'scene-1',
        sceneFingerprint: 'scene-fp',
        turnFingerprint: 'turn-fp',
        latestMesId: 2,
        messages: [
          { mesid: 1, role: 'assistant', text: 'A hidden draft.', visible: false },
          { mesid: 2, role: 'user', text: 'The lamp breaks.', visible: true }
        ]
      });
    },
    prompt: {
      async install(packet) {
        calls.install += 1;
        installed.push(packet);
        if (hostPrompt.install) return hostPrompt.install(packet);
        return { ok: true, installed: true };
      },
      async clear() {
        calls.clear += 1;
        cleared.push(true);
        if (hostPrompt.clear) return hostPrompt.clear();
        return { ok: true, cleared: true };
      },
      ...hostPrompt.methods
    },
    messages: hostMessages,
    generation: hostGeneration
  };
  const runtime = createRecursionRuntime({ host, settingsStore, storage, activity, generationRouter: resolvedGenerationRouter, rapidHedgeDelayMs, rapidWarmJoinWaitMs });
  return { runtime, calls, installed, cleared, storage, settingsStore, activity, adapter };
}

function localFallbackCardRouter(diagnostics = ['unit-local-fallback-cards']) {
  return {
    async generate(roleId, request) {
      assertEqual(roleId, 'utilityArbiter', 'local fallback card router only handles Utility Arbiter');
      return {
        ok: true,
        data: {
          schema: UTILITY_ARBITER_SCHEMA,
          snapshotHash: request.snapshotHash,
          action: 'compose-brief',
          cardJobs: [],
          budgets: { targetBriefTokens: 500, maxCards: 6 },
          reasonerDecision: { mode: 'skip', reason: 'unit local fallback cards' },
          diagnostics
        }
      };
    }
  };
}

// Replaced V1 contract: dialogue/prose pass fixtures are retained as historical
// examples until the dedicated generation-review harness supersedes them.
if (false) {
{
  const proseHost = createProseMessageHarness();
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { enhancements: { target: 'off', applyMode: 'as-swipe', contextMessages: 13 } },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate(roleId, request, options) {
        routerCalls.push({ roleId, request, options });
        return {
          ok: true,
          data: {
            schema: 'recursion.proseEnhancer.v1',
            text: 'Mara clenched her jaw. "Keep the door shut," Mara said.'
          }
        };
      }
    }
  });
  const result = await runtime.enhanceLatestAssistantMessage({ reason: 'unit-off' });
  assertEqual(result.skipped, true, 'prose enhancement skips when off');
  assertEqual(routerCalls.length, 0, 'prose enhancement off does not call Utility');
  assertEqual(proseHost.calls.length, 0, 'prose enhancement off does not mutate host messages');
}

{
  const { runtime } = createRuntimeHarness({
    settings: { enhancements: { target: 'off', applyMode: 'as-swipe', contextMessages: 13 } }
  });
  await runtime.updateSettings({ enhancements: { target: 'on', applyMode: 'as-swipe' } });
  assertDeepEqual(
    runtime.view().settings.enhancements,
    { target: 'on', applyMode: 'as-swipe', contextMessages: 13 },
    'runtime safe view preserves Enhancements target for the compact bar'
  );
}

{
  const proseHost = createProseMessageHarness();
  const routerCalls = [];
  const snapshotMessages = Array.from({ length: 20 }, (_, index) => ({
    mesid: index,
    role: index % 2 ? 'user' : 'assistant',
    text: `Context message ${index}`,
    visible: true
  }));
  snapshotMessages.push({ mesid: 30, role: 'assistant', text: proseHost.message.text, visible: true });
  const { runtime } = createRuntimeHarness({
    settings: { enhancements: { target: 'prose', applyMode: 'as-swipe', contextMessages: 3 } },
    snapshot: {
      chatId: 'prose-runtime-chat',
      chatKey: 'prose-runtime-chat',
      sceneKey: 'prose-runtime-scene',
      sceneFingerprint: 'prose-runtime-scene-fp',
      turnFingerprint: 'prose-runtime-turn',
      latestMesId: 30,
      messages: snapshotMessages
    },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate(roleId, request, options) {
        routerCalls.push({ roleId, request, options });
        return {
          ok: true,
          data: {
            schema: 'recursion.proseEnhancer.v1',
            text: 'Mara clenched her jaw. "Keep the door shut," Mara said.'
          }
        };
      }
    }
  });
  const result = await runtime.enhanceLatestAssistantMessage({ reason: 'unit-as-swipe' });
  assertEqual(result.ok, true, 'As Swipe prose enhancement returns success');
  assertEqual(result.mode, 'as-swipe', 'As Swipe result reports mode');
  assertEqual(routerCalls[0].roleId, 'proseEnhancer', 'As Swipe calls proseEnhancer role');
  assertEqual(routerCalls[0].request.contextMessages.length, 3, 'As Swipe request respects context message setting');
  assertEqual(routerCalls[0].options.timeoutMs, 120000, 'As Swipe uses the long provider timeout for live Utility profiles');
  assertEqual(proseHost.calls[0].type, 'hold', 'As Swipe holds original message before provider pass');
  assertEqual(proseHost.calls.some((call) => call.type === 'append' && call.options.select === true), true, 'As Swipe appends and auto-selects enhanced swipe');
  assertEqual(proseHost.message.swipes[0], 'She was angry. "Keep the door shut," Mara said.', 'As Swipe preserves original text as first swipe after hold');
  assertEqual(proseHost.message.swipes[1], 'Mara clenched her jaw. "Keep the door shut," Mara said.', 'As Swipe stores enhanced text as second swipe');
  assertEqual(proseHost.message.swipeId, 1, 'As Swipe leaves enhanced swipe selected');
}

{
  const proseHost = createProseMessageHarness();
  const { runtime } = createRuntimeHarness({
    settings: { enhancements: { target: 'prose', applyMode: 'replace', contextMessages: 13 } },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate() {
        return {
          ok: true,
          data: {
            schema: 'recursion.proseEnhancer.v1',
            text: 'Mara clenched her jaw. "Keep the door shut," Mara said.'
          }
        };
      }
    }
  });
  const result = await runtime.enhanceLatestAssistantMessage({ reason: 'unit-replace' });
  assertEqual(result.ok, true, 'Replace prose enhancement returns success');
  assertEqual(result.mode, 'replace', 'Replace result reports mode');
  assertEqual(proseHost.calls.some((call) => call.type === 'replace'), true, 'Replace mutates active assistant text');
  assertEqual(proseHost.calls.some((call) => call.type === 'append'), false, 'Replace does not append a swipe');
  assertEqual(proseHost.calls.some((call) => call.type === 'reveal'), false, 'Replace success does not reveal original over enhanced text');
}

{
  const proseHost = createProseMessageHarness('Mara set the cup down. "So that is what we are calling it now?"');
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { enhancements: { target: 'dialogue', applyMode: 'as-swipe', contextMessages: 3 } },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate(roleId, request, options) {
        routerCalls.push({ roleId, request, options });
        return {
          ok: true,
          data: {
            schema: 'recursion.dialogueEnhancer.v1',
            text: 'Mara set the cup down. "Call it whatever lets you sleep."'
          }
        };
      }
    }
  });
  const result = await runtime.enhanceLatestAssistantMessage({ reason: 'unit-dialogue-as-swipe' });
  assertEqual(result.ok, true, 'Dialogue Enhancement returns success');
  assertEqual(result.target, 'dialogue', 'Dialogue result reports target');
  assertEqual(result.mode, 'as-swipe', 'Dialogue As Swipe result reports apply mode');
  assertDeepEqual(routerCalls.map((call) => call.roleId), ['dialogueEnhancer'], 'Dialogue target calls only dialogueEnhancer');
  assertEqual(proseHost.message.swipes[1], 'Mara set the cup down. "Call it whatever lets you sleep."', 'Dialogue target appends repaired dialogue swipe');
  assertEqual(proseHost.message.swipeId, 1, 'Dialogue target selects enhanced swipe');
}

const eligibilitySettings = {
  mode: 'auto',
  cardDecks: {
    activeCardDeckId: 'eligibility-deck',
    customCardDecks: {
      'eligibility-deck': {
        id: 'eligibility-deck',
        name: 'Eligibility Deck',
        categoryOrder: ['scene-frame', 'active-cast'],
        categories: {
          'scene-frame': { id: 'scene-frame', name: 'Scene Frame' },
          'active-cast': { id: 'active-cast', name: 'Active Cast' }
        },
        cardOrderByCategory: {
          'scene-frame': ['active-card', 'priority-card'],
          'active-cast': ['inactive-card']
        },
        cards: {
          'active-card': { id: 'active-card', categoryId: 'scene-frame', name: 'Active', promptText: 'Active prompt.', selectionState: 'active', builtinFamily: 'Scene Frame' },
          'priority-card': { id: 'priority-card', categoryId: 'scene-frame', name: 'Priority', promptText: 'Priority prompt.', selectionState: 'priority', builtinFamily: 'Scene Frame' },
          'inactive-card': { id: 'inactive-card', categoryId: 'active-cast', name: 'Inactive', promptText: 'Inactive prompt.', selectionState: 'off', builtinFamily: 'Active Cast' }
        }
      }
    }
  }
};
const eligibilityPlan = filterPlanForCardEligibility({
  cardJobs: [
    { family: 'Scene Frame', cardId: 'active-card' },
    { family: 'Active Cast', cardId: 'inactive-card' }
  ]
}, eligibilitySettings);
assertEqual(eligibilityPlan.plan.cardJobs.length, 1, 'Auto rejects inactive card jobs');
assertEqual(eligibilityPlan.omitted[0].reason, 'inactive-card-ineligible', 'Auto records inactive card rejection');
assertEqual(filterCardsForCardEligibility([
  { id: 'runtime-scene', family: 'Scene Frame' },
  { id: 'runtime-cast', family: 'Active Cast' }
], eligibilitySettings).length, 1, 'Auto filters runtime family cards to eligible deck families');
const changedEligibilitySettings = clone(eligibilitySettings);
changedEligibilitySettings.cardDecks.customCardDecks['eligibility-deck'].cards['active-card'].selectionState = 'off';
assertNotEqual(
  cacheContractVersions(eligibilitySettings).cardEligibilityHash,
  cacheContractVersions(changedEligibilitySettings).cardEligibilityHash,
  'Card state changes invalidate cache eligibility'
);

{
  const proseHost = createProseMessageHarness('O\'Neill looked at Carter. "Options?"');
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { enhancements: { target: 'dialogue', applyMode: 'as-swipe', contextMessages: 3 } },
    snapshot: {
      chatId: 'enhancement-context-chat',
      chatKey: 'enhancement-context-chat',
      sceneKey: 'enhancement-context-scene',
      sceneFingerprint: 'enhancement-context-fp',
      turnFingerprint: 'enhancement-context-turn',
      latestMesId: 3,
      messages: [
        { mesid: 1, role: 'assistant', sender: 'O\'Neill', text: '"Carter?"', visible: true },
        { mesid: 2, role: 'assistant', sender: 'Carter', text: '"Working on it, sir."', visible: true },
        { mesid: 3, role: 'assistant', sender: 'SG-1', text: proseHost.message.text, visible: true }
      ]
    },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate(roleId, request, options) {
        routerCalls.push({ roleId, request, options });
        return {
          ok: true,
          data: {
            schema: 'recursion.dialogueEnhancer.v1',
            text: 'O\'Neill looked at Carter. "Options?"'
          }
        };
      }
    }
  });
  await runtime.enhanceLatestAssistantMessage({ reason: 'unit-enhancement-sender-context' });
  assert(routerCalls[0].request.contextMessages.some((message) => message.sender === 'Carter'), 'Enhancement request preserves sender labels from the snapshot window');
  assertEqual(routerCalls[0].request.characterContext.name, 'SG-1', 'Dialogue Enhancement request receives active assistant sender as character context');
  assert(routerCalls[0].request.characterContext.exampleDialogue.includes('"Working on it, sir."'), 'Dialogue Enhancement request receives recent dialogue examples');
}

{
  const proseHost = createProseMessageHarness('Mara set the cup down. "Sit down before you fall over."');
  const roleCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { enhancements: { target: 'prose-dialogue', applyMode: 'replace', contextMessages: 3 } },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate(roleId) {
        roleCalls.push(roleId);
        return {
          ok: true,
          data: {
            schema: roleId === 'dialogueEnhancer' ? 'recursion.dialogueEnhancer.v1' : 'recursion.proseEnhancer.v1',
            text: 'Mara set the cup down. "Sit down before you fall over."'
          }
        };
      }
    }
  });
  const result = await runtime.enhanceLatestAssistantMessage({ reason: 'unit-prose-skipped-after-dialogue-noop' });
  assertEqual(result.ok, false, 'Prose + Dialogue fails when both paid passes remain unchanged after retry');
  assertDeepEqual(roleCalls, ['dialogueEnhancer', 'dialogueEnhancer', 'proseEnhancer', 'proseEnhancer'], 'Each selected pass retries once after an exact no-op');
  assertDeepEqual(result.passResults.map((entry) => entry.status), ['validation-failed', 'validation-failed'], 'Enhancement reports unchanged selected passes as explicit failures');
}

{
  const proseHost = createProseMessageHarness('Mara set the cup down. "Sit down before you fall over."');
  const roleCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { enhancements: { target: 'prose-dialogue', applyMode: 'replace', contextMessages: 3 } },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate(roleId) {
        roleCalls.push(roleId);
        if (roleId === 'dialogueEnhancer') {
          return { ok: false, error: { code: 'RECURSION_TEST_DIALOGUE_FAILED', message: 'dialogue unavailable' } };
        }
        return {
          ok: true,
          data: {
            schema: 'recursion.proseEnhancer.v1',
            text: 'Mara placed the cup down and kept her hand on it. "Sit down before you fall over."'
          }
        };
      }
    }
  });
  const result = await runtime.enhanceLatestAssistantMessage({ reason: 'unit-dialogue-failure-prose-continues' });
  assertEqual(result.ok, true, 'Prose applies when Dialogue provider fails');
  assertEqual(result.degraded, true, 'mixed pass result reports degraded status');
  assertDeepEqual(roleCalls, ['dialogueEnhancer', 'proseEnhancer'], 'Prose runs after Dialogue provider failure');
  assertDeepEqual(result.passResults.map((entry) => entry.status), ['provider-failed', 'applied'], 'mixed pass outcomes remain explicit');
  assertEqual(proseHost.message.text, 'Mara placed the cup down and kept her hand on it. "Sit down before you fall over."', 'Prose receives the original safe text after Dialogue failure');
}

{
  const proseHost = createProseMessageHarness('Mara set the cup down. "What do you want to do next?"');
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { enhancements: { target: 'dialogue', applyMode: 'as-swipe', contextMessages: 3 } },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push({ roleId, request });
        return {
          ok: true,
          data: {
            schema: 'recursion.dialogueEnhancer.v1',
            text: 'Mara set the cup down. "What do you want to do next?"'
          }
        };
      }
    }
  });
  const result = await runtime.enhanceLatestAssistantMessage({ reason: 'unit-dialogue-noop-detected-slop' });
  assertEqual(result.ok, false, 'detected dialogue slop exact no-op fails after retry');
  assertEqual(result.error?.code, 'RECURSION_ENHANCEMENT_PASS_FAILED', 'detected dialogue slop reports the unchanged pass failure');
  assertEqual(routerCalls.length, 2, 'detected dialogue slop exact no-op retries once');
  assertEqual(proseHost.message.swipes.length, 1, 'failed dialogue no-op does not append enhanced swipe');
  assertEqual(proseHost.message.text, 'Mara set the cup down. "What do you want to do next?"', 'failed dialogue no-op keeps original text');
}

{
  const proseHost = createProseMessageHarness('Mara set the cup down. "Sit down before you fall over."');
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { enhancements: { target: 'dialogue', applyMode: 'as-swipe', contextMessages: 3 } },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push({ roleId, request });
        return {
          ok: true,
          data: {
            schema: 'recursion.dialogueEnhancer.v1',
            text: 'Mara set the cup down. "Sit down before you fall over."'
          }
        };
      }
    }
  });
  const result = await runtime.enhanceLatestAssistantMessage({ reason: 'unit-dialogue-clean-noop' });
  assertEqual(result.ok, false, 'clean dialogue exact no-op fails after retry');
  assertEqual(result.error?.code, 'RECURSION_ENHANCEMENT_PASS_FAILED', 'clean dialogue exact no-op reports the unchanged pass failure');
  assertEqual(routerCalls.length, 2, 'clean dialogue exact no-op spends one retry');
  assertEqual(proseHost.message.swipes.length, 1, 'clean dialogue exact no-op does not append duplicate swipe');
}

{
  const proseHost = createProseMessageHarness('Mara set the cup down. "Sit down before you fall over."');
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { enhancements: { target: 'dialogue', applyMode: 'as-swipe', contextMessages: 3 } },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push({ roleId, request });
        return {
          ok: true,
          data: {
            schema: 'recursion.dialogueEnhancer.v1',
            text: routerCalls.length === 1
              ? 'Mara set the cup down. "Sit down before you fall over."'
              : 'Mara set the cup down. "Sit. We can argue after."'
          }
        };
      }
    }
  });
  const result = await runtime.enhanceLatestAssistantMessage({ reason: 'unit-dialogue-clean-noop-retries' });
  assertEqual(result.ok, true, 'clean dialogue no-op accepts a revision from its retry');
  assertEqual(routerCalls.length, 2, 'clean dialogue no-op retries once');
  assertEqual(proseHost.message.swipes.length, 2, 'clean dialogue retry appends the real enhanced swipe');
}

{
  const proseHost = createProseMessageHarness('Mara set the cup down. "Sit down before you fall over."');
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { enhancements: { target: 'dialogue', applyMode: 'as-swipe', contextMessages: 3 } },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push({ roleId, request });
        return {
          ok: true,
          data: {
            schema: 'recursion.dialogueEnhancer.v1',
            text: 'Mara set the cup down. "Sit down before you fall over."'
          }
        };
      }
    }
  });
  const result = await runtime.enhanceLatestAssistantMessage({ reason: 'unit-dialogue-exact-noop-skips-after-retry' });
  assertEqual(result.ok, false, 'Dialogue exact no-op fails after the required retry');
  assertEqual(result.error?.code, 'RECURSION_ENHANCEMENT_PASS_FAILED', 'Dialogue exact no-op reports an explicit pass failure');
  assertEqual(routerCalls.length, 2, 'Dialogue exact no-op retries once before failing');
  assertEqual(proseHost.message.swipes.length, 1, 'exact duplicate enhanced swipe is not appended');
}

{
  const proseHost = createProseMessageHarness('Mara set the cup down. "Tell me what you want."');
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { enhancements: { target: 'dialogue', applyMode: 'replace', contextMessages: 3 } },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push({ roleId, request });
        return {
          ok: true,
          data: {
            schema: 'recursion.dialogueEnhancer.v1',
            text: routerCalls.length === 1
              ? 'Mara set the cup down. "Tell me what you want?"'
              : 'Mara set the cup down. "Start with the part you keep dodging."'
          }
        };
      }
    }
  });
  const result = await runtime.enhanceLatestAssistantMessage({ reason: 'unit-dialogue-soft-suspicion-low-ratio-retry' });
  assertEqual(result.ok, true, 'soft-suspicion low-ratio output gets a stronger retry');
  assertEqual(routerCalls.length, 2, 'soft suspicion low-ratio retry runs once');
  assert(routerCalls[1].request.prompt.includes('previous revision stayed too close'), 'low-ratio retry prompt asks for stronger revision');
  assertEqual(proseHost.message.text, 'Mara set the cup down. "Start with the part you keep dodging."', 'low-ratio retry replacement is applied');
  assertEqual(result.passHashes[0].retryReason, 'low-dialogue-edit-ratio', 'low-ratio retry reason is recorded');
  assertEqual(typeof result.passHashes[0].dialogueEditRatio, 'number', 'low-ratio retry marker records dialogue edit ratio');
}

{
  const proseHost = createProseMessageHarness('Mara set the cup down. "What do you want to do next?"');
  const roleCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { enhancements: { target: 'prose-dialogue', applyMode: 'replace', contextMessages: 3 } },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate(roleId) {
        roleCalls.push(roleId);
        if (roleId === 'dialogueEnhancer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.dialogueEnhancer.v1',
              text: 'Mara set the cup down. "Sit down before you fall over. We can argue after."'
            }
          };
        }
        return {
          ok: true,
          data: {
            schema: 'recursion.proseEnhancer.v1',
            text: 'Mara placed the cup on the table. "Sit down before you fall over. We can argue after."'
          }
        };
      }
    }
  });
  const result = await runtime.enhanceLatestAssistantMessage({ reason: 'unit-prose-dialogue-replace' });
  assertEqual(result.ok, true, 'Prose + Dialogue enhancement succeeds');
  assertEqual(result.target, 'prose-dialogue', 'Prose + Dialogue result reports target');
  assertDeepEqual(roleCalls, ['dialogueEnhancer', 'proseEnhancer'], 'Prose + Dialogue runs Dialogue before Prose');
  assertDeepEqual(result.passResults.map((entry) => entry.status), ['applied', 'applied'], 'Prose + Dialogue reports pass outcomes');
  assertEqual(proseHost.message.text, 'Mara placed the cup on the table. "Sit down before you fall over. We can argue after."', 'Replace applies one final output');
  const replaceCall = proseHost.calls.find((call) => call.type === 'replace');
  assertEqual(typeof result.editRatio, 'number', 'Prose + Dialogue result reports final edit ratio');
  assertEqual(typeof replaceCall.options.marker.editRatio, 'number', 'Prose + Dialogue marker records final edit ratio');
  assertEqual(replaceCall.options.marker.passHashes.every((entry) => typeof entry.editRatio === 'number'), true, 'Prose + Dialogue marker records per-pass edit ratios');
}

{
  const proseHost = createProseMessageHarness();
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: healthyReasonerSettings({
      reasoningLevel: 'high',
      enhancements: { target: 'prose', applyMode: 'as-swipe', contextMessages: 13 }
    }),
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate(roleId, request, options) {
        routerCalls.push({ roleId, request, options });
        return {
          ok: true,
          data: {
            schema: 'recursion.proseEnhancer.v1',
            text: 'Mara clenched her jaw. "Keep the door shut," Mara said.'
          }
        };
      }
    }
  });
  const result = await runtime.enhanceLatestAssistantMessage({ reason: 'unit-high-reasoner-enhancement' });
  assertEqual(result.ok, true, 'High reasoning prose enhancement succeeds');
  assertEqual(routerCalls[0].roleId, 'proseEnhancer', 'High reasoning still uses proseEnhancer role');
  assertEqual(routerCalls[0].request.lane, 'reasoner', 'High reasoning routes prose enhancement through Reasoner lane');
  assertEqual(routerCalls[0].request.reasoningCategory, 'enhancement', 'High reasoning labels enhancement provider work');
  assertEqual(routerCalls[0].request.reasoningIntent, 'medium', 'High reasoning asks enhancement Reasoner calls for medium provider reasoning');
}

{
  const proseHost = createProseMessageHarness('Mara set the cup down. "So that is what we are calling it now?"');
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: {
      reasoningLevel: 'high',
      providers: { reasoner: { enabled: false, lastTest: { status: 'pass' } } },
      enhancements: { target: 'dialogue', applyMode: 'as-swipe', contextMessages: 13 }
    },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push({ roleId, request });
        return {
          ok: true,
          data: {
            schema: 'recursion.dialogueEnhancer.v1',
            text: 'Mara set the cup down. "Call it whatever lets you sleep."'
          }
        };
      }
    }
  });
  const result = await runtime.enhanceLatestAssistantMessage({ reason: 'unit-high-disabled-reasoner-enhancement' });
  assertEqual(result.ok, true, 'High reasoning enhancement falls back to Utility when Reasoner is unavailable');
  assertEqual(routerCalls[0].roleId, 'dialogueEnhancer', 'High reasoning unavailable Reasoner still calls selected enhancer role');
  assertEqual(routerCalls[0].request.lane, 'utility', 'High reasoning unavailable Reasoner routes enhancement through Utility');
  assertEqual(proseHost.message.swipes[1], 'Mara set the cup down. "Call it whatever lets you sleep."', 'Utility fallback enhancement appends repaired dialogue swipe');
}

{
  const proseHost = createProseMessageHarness('Mara set the cup down. "So that is what we are calling it now?"');
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: healthyReasonerSettings({
      reasoningLevel: 'high',
      enhancements: { target: 'dialogue', applyMode: 'as-swipe', contextMessages: 13 }
    }),
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push({ roleId, request });
        if (request.lane === 'reasoner') {
          return {
            ok: false,
            lane: 'reasoner',
            error: { code: 'RECURSION_PROVIDER_FAILED', message: 'Reasoner failed after retry.' },
            diagnostics: { retryCount: 1 }
          };
        }
        return {
          ok: true,
          lane: 'utility',
          data: {
            schema: 'recursion.dialogueEnhancer.v1',
            text: 'Mara set the cup down. "Call it whatever lets you sleep."'
          }
        };
      }
    }
  });
  const result = await runtime.enhanceLatestAssistantMessage({ reason: 'unit-reasoner-failed-utility-fallback-enhancement' });
  assertEqual(result.ok, true, 'High reasoning enhancement falls back to Utility after Reasoner failure');
  assertDeepEqual(routerCalls.map((call) => call.request.lane), ['reasoner', 'utility'], 'Reasoner enhancement failure retries the pass through Utility');
  assertEqual(result.passHashes[0].lane, 'utility', 'fallback pass records Utility as applied lane');
  assertEqual(result.passHashes[0].fallbackFrom, 'reasoner', 'fallback pass records Reasoner fallback source');
}

{
  const proseHost = createProseMessageHarness('Mara set the cup down. "What do you want to do next?"');
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: healthyReasonerSettings({
      reasoningLevel: 'ultra',
      enhancements: { target: 'prose-dialogue', applyMode: 'replace', contextMessages: 3 }
    }),
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate(roleId, request, options) {
        routerCalls.push({ roleId, request, options });
        if (roleId === 'dialogueEnhancer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.dialogueEnhancer.v1',
              text: 'Mara set the cup down. "Sit down before you fall over. We can argue after."'
            }
          };
        }
        return {
          ok: true,
          data: {
            schema: 'recursion.proseEnhancer.v1',
            text: 'Mara placed the cup on the table. "Sit down before you fall over. We can argue after."'
          }
        };
      }
    }
  });
  const result = await runtime.enhanceLatestAssistantMessage({ reason: 'unit-ultra-reasoner-enhancement' });
  assertEqual(result.ok, true, 'Ultra reasoning Prose + Dialogue enhancement succeeds');
  assertDeepEqual(routerCalls.map((call) => call.roleId), ['dialogueEnhancer', 'proseEnhancer'], 'Ultra reasoning keeps Prose + Dialogue pass order');
  assert(routerCalls.every((call) => call.request.lane === 'reasoner'), 'Ultra reasoning routes every enhancement pass through Reasoner lane');
  assert(routerCalls.every((call) => call.request.reasoningCategory === 'enhancement'), 'Ultra reasoning labels every enhancement pass as enhancement work');
  assert(routerCalls.every((call) => call.request.reasoningIntent === 'high'), 'Ultra reasoning asks enhancement Reasoner calls for high provider reasoning');
}

{
  const proseHost = createProseMessageHarness();
  const { runtime } = createRuntimeHarness({
    settings: { enhancements: { target: 'prose', applyMode: 'as-swipe', contextMessages: 13 } },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate() {
        return {
          ok: true,
          data: {
            schema: 'recursion.proseEnhancer.v1',
            text: 'She was angry. "Keep the door shut," Mara said.'
          }
        };
      }
    }
  });
  const result = await runtime.enhanceLatestAssistantMessage({ reason: 'unit-as-swipe-unchanged' });
  assertEqual(result.ok, false, 'identical As Swipe prose enhancement fails after its required retry');
  assertEqual(result.error?.code, 'RECURSION_ENHANCEMENT_PASS_FAILED', 'identical As Swipe reports an explicit unchanged-pass failure');
  assertEqual(proseHost.calls.some((call) => call.type === 'append' && call.options.select === true), false, 'identical As Swipe does not append an unchanged swipe');
  assertEqual(proseHost.message.swipes.length, 1, 'identical As Swipe keeps only the original swipe');
  assertEqual(proseHost.message.swipeId, 0, 'identical As Swipe keeps the original selected');
}

{
  const proseHost = createProseMessageHarness();
  const { runtime } = createRuntimeHarness({
    settings: { enhancements: { target: 'prose', applyMode: 'replace', contextMessages: 13 } },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate() {
        return {
          ok: false,
          error: { code: 'RECURSION_TEST_PROVIDER_FAILED', message: 'provider failed' }
        };
      }
    }
  });
  const result = await runtime.enhanceLatestAssistantMessage({ reason: 'unit-failure' });
  assertEqual(result.ok, false, 'failed prose enhancement returns failure');
  assertEqual(proseHost.calls.some((call) => call.type === 'replace' || call.type === 'append'), false, 'failed prose enhancement leaves original unmutated');
  assertEqual(proseHost.calls.at(-1).type, 'reveal', 'failed prose enhancement reveals original');
}

{
  const proseHost = createProseMessageHarness();
  const providerGate = deferred();
  const { runtime } = createRuntimeHarness({
    settings: { enhancements: { target: 'prose', applyMode: 'replace', contextMessages: 13 } },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate(roleId, request = {}) {
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'skip',
              sceneStatus: 'same-scene',
              cardJobs: [],
              reasonerDecision: { mode: 'skip', reason: 'unit prose pending setup', signals: [] },
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              diagnostics: ['unit-prose-pending-setup']
            }
          };
        }
        assertEqual(roleId, 'proseEnhancer', 'pending prose fixture only calls proseEnhancer after setup');
        await providerGate.promise;
        return {
          ok: true,
          data: {
            schema: 'recursion.proseEnhancer.v1',
            text: 'Mara clenched her jaw. "Keep the door shut," Mara said.'
          }
        };
      }
    }
  });
  const setup = await runtime.prepareForGeneration({ userMessage: 'Prepare prose hold.', hostGeneration: true });
  assertEqual(setup.ok, true, 'prose hold setup prepares generation');
  assertEqual(runtime.view().hostGenerationActive, true, 'host generation remains active after prompt preparation');
  assertEqual(runtime.proseEnhancementPending(), true, 'prepareForGeneration arms pending prose enhancement when enabled');
  const enhance = runtime.enhanceLatestAssistantMessage({ reason: 'assistant-message-landed' });
  await waitUntil(
    () => proseHost.calls.some((call) => call.type === 'hold'),
    'pending prose enhancement holds assistant message before provider resolves'
  );
  assertEqual(runtime.view().hostGenerationActive, true, 'host generation remains active while prose enhancement is running');
  providerGate.resolve();
  const enhanced = await enhance;
  assertEqual(enhanced.ok, true, 'pending prose enhancement completes');
  assertEqual(runtime.proseEnhancementPending(), false, 'prose enhancement pending flag clears after enhancement completes');
  runtime.handleHostGenerationEnded({ eventName: 'generation_ended' });
  assertEqual(runtime.view().hostGenerationActive, false, 'host generation clears after prose enhancement completes');
}

{
  const proseHost = createProseMessageHarness();
  const roleCalls = [];
  const { runtime, storage } = createRuntimeHarness({
    settings: { enhancements: { target: 'prose', applyMode: 'replace', contextMessages: 13 } },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'skip',
              sceneStatus: 'same-scene',
              cardJobs: [],
              reasonerDecision: { mode: 'skip', reason: 'unit stopped prose setup', signals: [] },
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              diagnostics: ['unit-stopped-prose-setup']
            }
          };
        }
        throw new Error(`stopped generation must not call ${roleId}`);
      }
    }
  });
  const setup = await runtime.prepareForGeneration({ userMessage: 'Prepare prose, then stop.', hostGeneration: true });
  assertEqual(setup.ok, true, 'stopped prose setup prepares generation');
  assertEqual(runtime.proseEnhancementPending(), true, 'stopped prose setup arms pending prose enhancement');
  const stopped = await runtime.handleHostGenerationStopped({ eventName: 'generation_stopped' });
  assertEqual(stopped.ok, true, 'stopped prose cleanup succeeds');
  assertEqual(runtime.proseEnhancementPending(), false, 'generation stop clears pending prose enhancement');
  const lateEnhance = await runtime.enhanceLatestAssistantMessage({ reason: 'assistant-message-landed' });
  assertEqual(lateEnhance.skipped, true, 'late assistant-landed prose enhancement skips after generation stop');
  assertEqual(lateEnhance.reason, 'prose-enhancement-canceled', 'late assistant-landed prose enhancement reports cancellation');
  assertDeepEqual(roleCalls, ['utilityArbiter'], 'late assistant-landed prose enhancement does not call the prose provider after stop');
  assertEqual(proseHost.calls.length, 0, 'late assistant-landed prose enhancement does not mutate host messages after stop');
}

{
  const proseHost = createProseMessageHarness();
  const providerGate = deferred();
  const roleCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { pipelineMode: 'rapid', enhancements: { target: 'prose', applyMode: 'replace', contextMessages: 13 } },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'proseEnhancer') {
          await providerGate.promise;
          return {
            ok: true,
            data: {
              schema: 'recursion.proseEnhancer.v1',
              text: 'Mara clenched her jaw. "Keep the door shut," Mara said.'
            }
          };
        }
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'skip',
              sceneStatus: 'same-scene',
              cardJobs: [],
              reasonerDecision: { mode: 'skip', reason: 'unit prose barrier', signals: [] },
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              diagnostics: ['unit-prose-barrier']
            }
          };
        }
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'Rapid warm waits for the prose-enhanced source.',
              sourceCardIds: request.sourceCardIds || [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['unit-prose-barrier-guidance']
            }
          };
        }
        throw new Error(`unexpected prose barrier role ${roleId}`);
      }
    }
  });
  const enhance = runtime.enhanceLatestAssistantMessage({ reason: 'assistant-message-landed' });
  await waitUntil(
    () => proseHost.calls.some((call) => call.type === 'hold'),
    'barrier prose enhancement did not hold assistant message before provider wait'
  );
  const warm = runtime.warmRapidScene({ reason: 'unit-prose-barrier' });
  await delay(5);
  assertDeepEqual(roleCalls, ['proseEnhancer'], 'Rapid warm does not call Utility Arbiter while prose enhancement is active');
  providerGate.resolve();
  const enhanced = await enhance;
  assertEqual(enhanced.ok, true, 'barrier prose enhancement completes');
  const warmResult = await warm;
  assertEqual(warmResult.ok, true, 'Rapid warm resumes after prose enhancement settles');
  assert(roleCalls.includes('utilityArbiter'), 'Rapid warm calls Utility Arbiter after prose enhancement settles');
}

}

{
  const proseHost = createProseMessageHarness('Mara crossed the room. "Keep the door shut," Mara said.');
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { enhancements: { target: 'on', applyMode: 'as-swipe', contextMessages: 3 } },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push({ roleId, request });
        return {
          ok: true,
          data: {
            schema: 'recursion.generationReview.v1',
            sourceHash: proseHost.message.originalHash,
            assessment: { response: 'repaired' },
            reviewDomains: { dialogue: 'repaired', 'anti-slop': 'honored' },
            cardOutcomes: [],
            patches: [{
              id: 'dialogue:1',
              domain: 'dialogue',
              before: '"Keep the door shut,"',
              after: '"Keep the door shut," Mara said quietly.',
              reason: 'Adds a bounded delivery cue.',
              cardRefs: []
            }]
          }
        };
      }
    }
  });
  const result = await runtime.enhanceLatestAssistantMessage({ reason: 'unit-generation-review' });
  assertEqual(result.ok, true, 'generation review applies a valid bounded patch');
  assertDeepEqual(routerCalls.map((call) => call.roleId), ['generationReviewer'], 'generation review makes one reviewer call');
  assertEqual(proseHost.message.swipes.length, 2, 'As Swipe preserves the original and adds one reviewed swipe');
  assert(proseHost.message.text.includes('said quietly'), 'generation review selects the reviewed swipe');
}

{
  const proseHost = createProseMessageHarness('Mara crossed the room. "Keep the door shut," Mara said.');
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { enhancements: { target: 'on', applyMode: 'as-swipe', contextMessages: 3 } },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push({ roleId, request });
        return {
          ok: true,
          recoverySpent: true,
          data: {
            schema: 'recursion.generationReview.v1',
            sourceHash: proseHost.message.originalHash,
            assessment: {},
            reviewDomains: {},
            cardOutcomes: [],
            patches: []
          }
        };
      }
    }
  });
  const result = await runtime.enhanceLatestAssistantMessage({ reason: 'unit-generation-review-budget' });
  assertEqual(result.ok, false, 'spent structured recovery with no patch remains a failed review');
  assertEqual(routerCalls.length, 1, 'runtime does not make a second semantic correction after router recovery spent the budget');
}

for (const pipelineMode of ['standard', 'rapid', 'fused']) {
  const proseHost = createProseMessageHarness('Mara crossed the room. "Keep the door shut," Mara said.');
  const routerCalls = [];
  const { runtime, activity } = createRuntimeHarness({
    settings: { pipelineMode, enhancements: { target: 'on', applyMode: 'as-swipe', contextMessages: 3 } },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push({ roleId, request });
        return {
          ok: true,
          data: {
            schema: 'recursion.generationReview.v1',
            sourceHash: proseHost.message.originalHash,
            assessment: {},
            reviewDomains: {},
            cardOutcomes: [],
            patches: [{
              id: 'unknown:target',
              domain: 'dialogue',
              before: 'not a frozen target',
              after: 'This response must not be applied.',
              reason: 'Invalid target regression fixture.',
              cardRefs: []
            }]
          }
        };
      }
    }
  });
  const result = await runtime.enhanceLatestAssistantMessage({ reason: `unit-${pipelineMode}-generation-review-invalid-target` });
  assertEqual(result.ok, false, `${pipelineMode} retains the original response after reviewer correction exhaustion`);
  assertEqual(routerCalls.length, 2, `${pipelineMode} uses exactly one semantic correction for an invalid patch target`);
  assertEqual(proseHost.message.text, 'Mara crossed the room. "Keep the door shut," Mara said.', `${pipelineMode} retains the visible original response`);
  assertEqual(proseHost.message.swipes.length, 1, `${pipelineMode} does not append an invalid reviewed swipe`);
  assert(activity.history().some((event) => event.phase === 'generationReviewing' && event.severity === 'error'), `${pipelineMode} records the review failure as a red review step`);
  assertEqual(activity.current().severity, 'success', `${pipelineMode} preserves the successful prompt-ready state after review failure`);
}

for (const pipelineMode of ['standard', 'rapid', 'fused']) {
  const proseHost = createProseMessageHarness('Mara crossed the room. "Keep the door shut," Mara said.');
  const reviewerRequests = [];
  const { runtime } = createRuntimeHarness({
    settings: { pipelineMode, enhancements: { target: 'on', applyMode: 'as-swipe', contextMessages: 3 } },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate(roleId, request) {
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              cardJobs: [],
              budgets: { targetBriefTokens: 500, maxCards: 6 },
              reasonerDecision: { mode: 'skip', reason: 'generation review outcome contract fixture' },
              diagnostics: []
            }
          };
        }
        if (roleId !== 'generationReviewer') throw new Error(`Unexpected reviewer fixture role: ${roleId}`);
        reviewerRequests.push(request);
        const cardIds = request.reviewSnapshot?.installedHand?.map((card) => card.cardId).filter(Boolean) || [];
        assert(cardIds.length > 0, `${pipelineMode} reviewer receives the prepared installed hand`);
        return {
          ok: true,
          data: {
            schema: 'recursion.generationReview.v1',
            sourceHash: proseHost.message.originalHash,
            assessment: { response: 'repaired' },
            reviewDomains: { dialogue: 'repaired' },
            cardOutcomes: cardIds.map((cardId) => ({
              cardId,
              status: reviewerRequests.length === 1 ? 'included' : 'honored',
              evidenceTargetIds: []
            })),
            patches: [{
              id: 'dialogue:1',
              domain: 'dialogue',
              before: '"Keep the door shut,"',
              after: '"Keep the door shut," Mara said quietly.',
              reason: 'Adds a bounded delivery cue.',
              cardRefs: []
            }]
          }
        };
      }
    }
  });
  const prepared = await runtime.prepareForGeneration({ userMessage: 'The lamp breaks.' });
  assertEqual(prepared.ok, true, `${pipelineMode} prepares a hand before review`);
  assert(runtime.view().lastHand.cards.length > 0, `${pipelineMode} retains generated cards for review`);
  const result = await runtime.enhanceLatestAssistantMessage({ reason: `unit-${pipelineMode}-generation-review-invalid-outcome` });
  assertEqual(result.ok, true, `${pipelineMode} corrects an unsupported card outcome status`);
  assertEqual(result.installedCardCount, result.cardOutcomes.length, `${pipelineMode} reports the frozen installed-card count used to validate the review ledger`);
  assertEqual(reviewerRequests.length, 2, `${pipelineMode} retries once after an unsupported card outcome status`);
  const retryPrompt = reviewerRequests[1].prompt;
  assert(retryPrompt.includes('Allowed card outcome statuses: honored, repaired, not-applicable, partially-reflected, violated, requires-regeneration.'), `${pipelineMode} retry repeats the outcome enum`);
  for (const card of reviewerRequests[1].reviewSnapshot.installedHand) {
    assert(retryPrompt.includes(`"cardId":"${card.cardId}","status":"honored","evidenceTargetIds":[]`), `${pipelineMode} retry requires complete coverage for ${card.cardId}`);
  }
}

{
  const baseline = rapidWarmContractVersions({ pipelineMode: 'rapid', mode: 'auto' });
  const unrelated = rapidWarmContractVersions({
    pipelineMode: 'rapid',
    mode: 'auto',
    retention: { sourceVariantsPerScene: 12, runJournalEntries: 12 },
    providers: {
      reasoner: {
        enabled: true,
        source: 'openai-compatible',
        openAICompatible: { baseUrl: 'https://reasoner.changed/v1', model: 'changed-reasoner' },
        temperature: 0.1,
        topP: 1,
        maxTokens: 4096
      }
    }
  });
  const utilityChanged = rapidWarmContractVersions({
    pipelineMode: 'rapid',
    mode: 'auto',
    providers: {
      utility: {
        enabled: true,
        source: 'openai-compatible',
        openAICompatible: { baseUrl: 'https://utility.changed/v1', model: 'changed-utility' },
        temperature: 0.3,
        topP: 1,
        maxTokens: 4096
      }
    }
  });
  assertEqual(unrelated.settingsHash, baseline.settingsHash, 'Rapid warm settings hash ignores unrelated retention and Reasoner drift');
  assertNotEqual(utilityChanged.settingsHash, baseline.settingsHash, 'Rapid warm settings hash changes for Utility provider drift');
}

{
  const roleCalls = [];
  const assistantText = [
    'You stand beside the humming archive door as the ward-lines brighten.',
    'Mara watches from the stairwell and thinks the lock is waking too quickly.',
    'You hear the brass pins shift under your hand.',
    'Her fingers tighten around the lamp as she studies the shadow under the frame.'
  ].join(' ');
  const mixedWarmMessages = [
    { mesid: 1, role: 'user', text: 'I ask in first person.', textHash: hashJson('I ask in first person.'), visible: true },
    { mesid: 4, role: 'assistant', text: assistantText, textHash: hashJson(assistantText), visible: true }
  ];
  const mixedWarmSourceRevisionHash = sourceFingerprintForMessages(mixedWarmMessages, 1, 4);
  const mixedWarmSnapshot = {
    chatId: 'rapid-mixed-auto-chat',
    chatKey: 'rapid-mixed-auto-chat',
    sceneKey: 'rapid-mixed-auto-scene',
    sceneFingerprint: 'rapid-mixed-auto-scene-fp',
    turnFingerprint: hashJson({ latestMesId: 4, sourceRevisionHash: mixedWarmSourceRevisionHash }),
    sourceRevisionHash: mixedWarmSourceRevisionHash,
    latestMesId: 4,
    messages: mixedWarmMessages
  };
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'rapid', mode: 'auto' },
    snapshot: mixedWarmSnapshot,
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'refresh-cards',
              sceneStatus: 'same-scene',
              promptFootprint: 'normal',
              storyForm: {
                schema: 'recursion.storyForm.v1',
                tense: 'present',
                pov: 'second-person',
                confidence: 'high',
                evidenceRefs: ['message:4'],
                reason: 'Warm Arbiter saw second person only.'
              },
              cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Warm scene frame.' }],
              reasonerDecision: { mode: 'skip', reason: 'background warm', signals: [] },
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              diagnostics: ['rapid-background-warm']
            }
          };
        }
        if (roleId === 'sceneFrameCard') return cardProviderResponse(roleId, request);
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'GUIDANCE_MARKER warm provider guidance.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['rapid-warm-guidance']
            }
          };
        }
        throw new Error(`unexpected role ${roleId}`);
      }
    }
  });
  assertEqual(typeof harness.runtime.warmRapidScene, 'function', 'runtime exposes Rapid warm entrypoint');
  const warm = await harness.runtime.warmRapidScene({ reason: 'test-idle' });
  assertEqual(warm.ok, true, 'Rapid background warm succeeds');
  assert(roleCalls.includes('utilityArbiter'), 'Rapid warm uses provider Arbiter');
  assert(roleCalls.includes('sceneFrameCard'), 'Rapid warm generates provider card');
  const cache = await harness.storage.loadSceneCache(mixedWarmSnapshot.chatKey, mixedWarmSnapshot.sceneKey);
  const variant = cache.variants[cache.activeSourceRevisionHash];
  assertEqual(variant.rapid.status, 'ready', 'Rapid warm artifact is ready');
  assertEqual(variant.rapid.pipelineVersion, 2, 'Rapid warm artifact uses v2');
  assert(variant.rapid.guidance.text.includes('GUIDANCE_MARKER'), 'Rapid warm stores provider guidance');
  assertEqual(variant.rapid.storyForm.tense, 'present', 'Rapid warm stores story tense');
  assertEqual(variant.rapid.storyForm.pov, 'mixed', 'Rapid warm Auto stores heuristic-corrected mixed story pov');
  assertDeepEqual(variant.rapid.selectedCardIds, variant.latestHand.cardIds, 'Rapid warm stores selected card ids');
  assert(!Object.prototype.hasOwnProperty.call(variant.rapid, 'conditionedSceneBrief'), 'Rapid warm no longer stores conditionedSceneBrief');
  assertEqual(harness.installed.length, 0, 'Rapid warm does not install prompt');
}

{
  const roleCalls = [];
  const hostStartCalls = [];
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'standard', mode: 'auto', reasonerUse: 'off' },
    hostGeneration: {
      async start(details = {}) {
        hostStartCalls.push(details);
        return { ok: true, started: true };
      }
    },
    generationRouter: {
      async generate(roleId) {
        roleCalls.push(roleId);
        throw new Error(`pipeline switch should not call provider role ${roleId}`);
      }
    }
  });

  const update = await harness.runtime.updateSettings({ pipelineMode: 'rapid' });
  assertEqual(update.ok, true, 'switching to Rapid succeeds');
  assertEqual(update.settings.pipelineMode, 'rapid', 'settings update records Rapid pipeline');
  assertEqual(update.warm, undefined, 'switching to Rapid does not queue a scene warm');
  assertDeepEqual(roleCalls, [], 'switching pipeline does not call providers');
  assertDeepEqual(hostStartCalls, [], 'switching pipeline does not start host generation');
  assertEqual(harness.runtime.view().settings.pipelineMode, 'rapid', 'runtime view shows the selected next pipeline');
}

{
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'standard', mode: 'auto', reasonerUse: 'off' }
  });

  const beforeClearCount = harness.calls.clear;
  const result = await harness.runtime.updateSettings({ pipelineMode: 'standard' });
  assertEqual(result.ok, true, 'selecting the current pipeline succeeds');
  assertEqual(harness.calls.clear, beforeClearCount, 'selecting the current pipeline does not clear the prompt');
}

{
  const roleCalls = [];
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'standard', mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Pipeline switch next generation.' }],
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              reasonerDecision: { mode: 'skip', reason: 'pipeline switch test', signals: [] },
              diagnostics: ['pipeline-switch-next-generation']
            }
          };
        }
        if (roleId === 'fusedCardBundle') {
          return {
            ok: true,
            roleId,
            lane: 'utility',
            data: {
              schema: 'recursion.cardBundle.v1',
              snapshotHash: request.snapshotHash,
              items: [{
                schema: 'recursion.card.v1',
                family: 'Scene Frame',
                role: 'sceneFrameCard',
                promptText: 'Pipeline-switched Fused card.',
                evidenceRefs: ['message:2'],
                tokenEstimate: 12
              }]
            }
          };
        }
        if (roleId === 'sceneFrameCard') return cardProviderResponse(roleId, request);
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'Use the newly selected Standard path.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['pipeline-switch-guidance']
            }
          };
        }
        throw new Error(`unexpected role after pipeline switch ${roleId}`);
      }
    }
  });

  await harness.runtime.updateSettings({ pipelineMode: 'fused' });
  const result = await harness.runtime.prepareForGeneration({ userMessage: 'Use the new pipeline.', hostGeneration: true });
  assertEqual(result.ok, true, 'next generation after pipeline switch succeeds');
  assertEqual(result.packet.diagnostics.pipelineMode, 'fused', 'next generation uses the selected pipeline mode');
  assert(roleCalls.includes('fusedCardBundle'), 'next generation enters the Fused card bundle path');
}

{
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'rapid', mode: 'auto' },
    generationRouter: {
      async generate(roleId, request = {}) {
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'skip',
              sceneStatus: 'same-scene',
              promptFootprint: 'compact',
              cardJobs: [],
              reasonerDecision: { mode: 'skip', reason: 'provider said skip', signals: [] },
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              diagnostics: ['warm-arbiter-skip-no-cache']
            }
          };
        }
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'Rapid fallback warm guidance.',
              sourceCardIds: request.sourceCardIds || [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['rapid-fallback-guidance']
            }
          };
        }
        throw new Error(`unexpected no-candidate warm role ${roleId}`);
      }
    }
  });
  const warm = await harness.runtime.warmRapidScene({ reason: 'unit-no-candidate-skip' });
  assertEqual(warm.ok, true, 'Rapid warm succeeds with fallback cards when provider returns no candidates');
  assertEqual(warm.rapid.status, 'ready', 'Rapid no-candidate warm persists ready artifact');
  assert(warm.rapid.diagnostics.includes('rapid-warm-local-fallback-cards'), 'Rapid no-candidate warm records fallback-card diagnostic');
  assertEqual(harness.runtime.view().rapidWarm.status, 'ready', 'Rapid view exposes fallback warm as ready');
  const cache = await harness.storage.loadSceneCache('chat-1', 'scene-1');
  const variant = cache.variants[cache.activeSourceRevisionHash];
  assertEqual(variant.rapid.status, 'ready', 'Rapid no-candidate warm persists ready artifact');
  assert(variant.cards.length > 0, 'Rapid no-candidate warm persists fallback cards');
}

{
  const generatedRoles = [];
  const harness = createRuntimeHarness({
    settings: {
      mode: 'auto',
      pipelineMode: 'rapid',
      reasoningLevel: 'medium',
      reasonerUse: 'off',
      strength: 'strong',
      promptFootprint: 'rich',
      minCards: 5,
      maxCards: 12
    },
    generationRouter: {
      async generate(roleId, request) {
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'refresh-cards',
              sceneStatus: 'same-scene',
              promptFootprint: 'rich',
              cardJobs: CARD_CATALOG.map((entry) => ({
                family: entry.family,
                role: entry.role,
                reason: `Warm ${entry.family}.`
              })),
              reasonerDecision: { mode: 'skip', reason: 'rapid cost regression fixture', signals: [] },
              budgets: { targetBriefTokens: 500, maxCards: 6 },
              diagnostics: ['rapid-cost-regression-fixture']
            }
          };
        }
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'Keep the Rapid warm selected cards only.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['rapid-guidance-ok']
            }
          };
        }
        generatedRoles.push(roleId);
        return {
          ok: true,
          roleId,
          data: {
            schema: 'recursion.card.v1',
            role: request.metadata.role,
            family: request.metadata.family,
            snapshotHash: request.snapshotHash,
            items: [{
              promptText: `Keep ${request.metadata.family} available for the Rapid warm packet.`,
              evidenceRefs: ['message:2'],
              tokenEstimate: 140
            }]
          }
        };
      },
      async batch(requests) {
        return Promise.all(requests.map((request) => this.generate(request.roleId, request)));
      }
    }
  });

  const warm = await harness.runtime.warmRapidScene({ reason: 'rapid-cost-regression' });
  assertEqual(warm.ok, true, 'Rapid cost regression warm succeeds');
  assertEqual(generatedRoles.length, 6, 'Rapid warm does not call providers for discarded card jobs');
  assertEqual(warm.hand.cards.length, 6, 'Rapid warm selected hand uses the budgeted card jobs');
  assert(warm.plan.diagnostics.includes('card-jobs-budgeted'), 'Rapid warm records card job budgeting diagnostic');
}

{
  const arbiterGate = deferred();
  const roleCalls = [];
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'rapid', mode: 'auto' },
    rapidHedgeDelayMs: -1,
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          await arbiterGate.promise;
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'refresh-cards',
              sceneStatus: 'same-scene',
              promptFootprint: 'normal',
              storyForm: {
                schema: 'recursion.storyForm.v1',
                tense: 'past',
                pov: 'third-person-limited',
                confidence: 'high',
                evidenceRefs: ['message:2'],
                reason: 'Warm narration establishes form.'
              },
              cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Warm visible status.' }],
              reasonerDecision: { mode: 'skip', reason: 'background warm', signals: [] },
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              diagnostics: ['warm-non-abort']
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
                promptText: 'Warm card survives foreground send.',
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
              guidanceText: 'Warm guidance survives foreground send.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['warm-guidance']
            }
          };
        }
        if (roleId === 'rapidTurnDelta') {
          return {
            ok: true,
            data: {
              schema: 'recursion.rapidTurnDelta.v2',
              snapshotHash: request.snapshotHash,
              baseSourceRevisionHash: request.baseSourceRevisionHash,
              turnSourceRevisionHash: request.turnSourceRevisionHash,
              selectedCardIds: [],
              turnGuidanceText: 'Turn guidance after join.',
              guardrailCardIds: [],
              packetInstructions: [],
              backgroundRefreshRequests: [],
              mandatoryMissingCards: [],
              escalateToStandard: false,
              diagnostics: ['joined-warm']
            }
          };
        }
        throw new Error(`unexpected role ${roleId}`);
      }
    }
  });
  const warmPromise = harness.runtime.warmRapidScene({ reason: 'unit-non-abort' });
  await Promise.resolve();
  const foregroundPromise = harness.runtime.prepareForGeneration({ userMessage: 'Use current warm if ready.' });
  await Promise.resolve();
  arbiterGate.resolve();
  const [warmResult, foregroundResult] = await Promise.all([warmPromise, foregroundPromise]);
  assertEqual(warmResult.ok, true, 'background warm completes');
  assertEqual(foregroundResult.ok, true, 'foreground generation completes');
  assert(roleCalls.includes('rapidTurnDelta'), 'foreground uses Rapid delta after joining warm');
  assertEqual(foregroundResult.packet.diagnostics.rapidPath, 'warm-v2', 'joined foreground records Rapid warm path');
}

{
  const snapshotGate = deferred();
  let warmSnapshotReads = 0;
  let baseReleased = false;
  let standardStartedBeforeBase = false;
  const roleCalls = [];
  const { snapshot } = rapidWarmSnapshotFixture();
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'rapid', mode: 'auto' },
    rapidWarmJoinWaitMs: 200,
    snapshot: async () => {
      warmSnapshotReads += 1;
      if (warmSnapshotReads === 1) await snapshotGate.promise;
      return snapshot;
    },
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          if (!baseReleased && warmSnapshotReads > 1) standardStartedBeforeBase = true;
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'refresh-cards',
              sceneStatus: 'same-scene',
              promptFootprint: 'normal',
              cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Race warm card.' }],
              reasonerDecision: { mode: 'skip', reason: 'race warm', signals: [] },
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              diagnostics: ['rapid-warm-race']
            }
          };
        }
        if (roleId === 'sceneFrameCard') return cardProviderResponse(roleId, request, 'Race warm card text.');
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'Race warm guidance.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['race-warm-guidance']
            }
          };
        }
        if (roleId === 'rapidTurnDelta') {
          return {
            ok: true,
            data: {
              schema: 'recursion.rapidTurnDelta.v2',
              snapshotHash: request.snapshotHash,
              baseSourceRevisionHash: request.baseSourceRevisionHash,
              turnSourceRevisionHash: request.turnSourceRevisionHash,
              selectedCardIds: [],
              turnGuidanceText: 'RACE_JOIN_MARKER use newly warmed deck.',
              guardrailCardIds: [],
              packetInstructions: [],
              backgroundRefreshRequests: [],
              mandatoryMissingCards: [],
              escalateToStandard: false,
              diagnostics: ['race-joined']
            }
          };
        }
        throw new Error(`unexpected race role ${roleId}`);
      }
    }
  });
  const warmPromise = harness.runtime.warmRapidScene({ reason: 'unit-base-hash-race' });
  await Promise.resolve();
  const foregroundPromise = harness.runtime.prepareForGeneration({ userMessage: 'Join warm after base hash publishes.' });
  await delay(0);
  assertEqual(standardStartedBeforeBase, false, 'foreground waits for active warm base hash before starting Standard');
  baseReleased = true;
  snapshotGate.resolve();
  const [warmResult, foregroundResult] = await Promise.all([warmPromise, foregroundPromise]);
  assertEqual(warmResult.ok, true, 'race warm completes');
  assertEqual(foregroundResult.ok, true, 'foreground completes after base-hash race');
  assertEqual(foregroundResult.packet.diagnostics.pipelineMode, 'rapid', 'foreground waits for warm base hash instead of immediate Standard fallback');
  assert(roleCalls.includes('rapidTurnDelta'), 'race foreground uses Rapid delta');
}

{
  const { snapshot, baseSourceRevisionHash } = rapidWarmSnapshotFixture();
  const pendingText = 'Open the hatch now.';
  const visiblePendingSnapshot = {
    ...snapshot,
    latestMesId: 3,
    messages: [
      ...snapshot.messages,
      { mesid: 3, role: 'user', text: pendingText, textHash: hashJson(pendingText), visible: true }
    ]
  };
  visiblePendingSnapshot.sourceRevisionHash = sourceFingerprintForMessages(visiblePendingSnapshot.messages, 2, 3);
  visiblePendingSnapshot.turnFingerprint = hashJson({
    latestMesId: 3,
    sourceRevisionHash: visiblePendingSnapshot.sourceRevisionHash,
    messages: visiblePendingSnapshot.messages.slice(-3)
  });
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  await storage.saveSceneCache(snapshot.chatKey, snapshot.sceneKey, rapidWarmCacheFixture({ cardId: 'warm-card-1', baseSourceRevisionHash }));
  const roleCalls = [];
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'rapid', mode: 'auto' },
    snapshot: visiblePendingSnapshot,
    storage,
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'rapidTurnDelta') {
          return {
            ok: true,
            data: {
              schema: 'recursion.rapidTurnDelta.v2',
              snapshotHash: request.snapshotHash,
              baseSourceRevisionHash: request.baseSourceRevisionHash,
              turnSourceRevisionHash: request.turnSourceRevisionHash,
              selectedCardIds: ['warm-card-1'],
              turnGuidanceText: 'VISIBLE_PENDING_MARKER use warm deck after inferred pending user.',
              guardrailCardIds: [],
              packetInstructions: [],
              backgroundRefreshRequests: [],
              mandatoryMissingCards: [],
              escalateToStandard: false,
              diagnostics: ['visible-pending-inferred']
            }
          };
        }
        throw new Error(`unexpected visible pending role ${roleId}`);
      }
    }
  });

  const result = await harness.runtime.prepareForGeneration({ userMessage: null, hostGeneration: true });
  assertEqual(result.ok, true, 'visible pending-user host generation succeeds');
  assertEqual(result.packet.diagnostics.pipelineMode, 'rapid', 'visible pending user is stripped to find warm base');
  assertEqual(result.packet.diagnostics.rapidPath, 'warm-v2', 'visible pending user uses warm-v2 Rapid path');
  assert(roleCalls.includes('rapidTurnDelta'), 'visible pending user calls Rapid turn delta');
}

{
  const { snapshot, baseSourceRevisionHash } = rapidWarmSnapshotFixture();
  const assistantBefore = { mesid: 3, role: 'assistant', text: 'Mara starts to answer.', textHash: hashJson('Mara starts to answer.'), visible: true };
  const pendingText = 'Ask Mara again.';
  const pending = { mesid: 4, role: 'user', text: pendingText, textHash: hashJson(pendingText), visible: true };
  const baseMessages = [...snapshot.messages, assistantBefore];
  const firstSnapshot = {
    ...snapshot,
    latestMesId: 4,
    messages: [...baseMessages, pending]
  };
  firstSnapshot.sourceRevisionHash = sourceFingerprintForMessages(firstSnapshot.messages, 2, 4);
  const driftedAssistant = {
    ...assistantBefore,
    text: 'Mara starts to answer, then swallows the name.',
    textHash: hashJson('Mara starts to answer, then swallows the name.')
  };
  const secondSnapshot = {
    ...firstSnapshot,
    messages: [snapshot.messages[0], driftedAssistant, pending]
  };
  secondSnapshot.sourceRevisionHash = sourceFingerprintForMessages(secondSnapshot.messages, 2, 4);
  let snapshotReads = 0;
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  const warmBaseSnapshot = {
    ...snapshot,
    latestMesId: 3,
    messages: baseMessages
  };
  warmBaseSnapshot.sourceRevisionHash = sourceFingerprintForMessages(warmBaseSnapshot.messages, 2, 3);
  await storage.saveSceneCache(
    snapshot.chatKey,
    snapshot.sceneKey,
    rapidWarmCacheFixture({
      cardId: 'warm-card-1',
      baseSourceRevisionHash: warmBaseSnapshot.sourceRevisionHash,
      firstMesId: 2,
      lastMesId: 3,
      evidenceRefs: ['message:2', 'message:3']
    })
  );
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'rapid', mode: 'auto' },
    snapshot: async () => {
      snapshotReads += 1;
      return snapshotReads <= 1 ? firstSnapshot : secondSnapshot;
    },
    storage,
    generationRouter: {
      async generate(roleId, request = {}) {
        if (roleId === 'rapidTurnDelta') {
          return {
            ok: true,
            data: {
              schema: 'recursion.rapidTurnDelta.v2',
              snapshotHash: request.snapshotHash,
              baseSourceRevisionHash: request.baseSourceRevisionHash,
              turnSourceRevisionHash: request.turnSourceRevisionHash,
              selectedCardIds: ['warm-card-1'],
              turnGuidanceText: 'PREFIX_DRIFT_MARKER keep Rapid packet for same pending user.',
              guardrailCardIds: [],
              packetInstructions: [],
              backgroundRefreshRequests: [],
              mandatoryMissingCards: [],
              escalateToStandard: false,
              diagnostics: ['prefix-drift-same-user']
            }
          };
        }
        throw new Error(`unexpected prefix drift role ${roleId}`);
      }
    }
  });

  const result = await harness.runtime.prepareForGeneration({ userMessage: null, hostGeneration: true });
  assertEqual(result.ok, true, 'same pending-user prefix drift still installs');
  assertEqual(result.skipped, undefined, `same pending-user prefix drift does not skip prompt install ${JSON.stringify({
    skipped: result.skipped,
    reason: result.reason,
    diagnostics: result.plan?.diagnostics,
    packet: result.packet?.diagnostics
  })}`);
  assertEqual(result.packet.diagnostics.pipelineMode, 'rapid', 'same pending-user prefix drift keeps Rapid packet');
  assertEqual(result.packet.diagnostics.rapidPath, 'warm-v2', 'same pending-user prefix drift keeps Rapid warm path');
}

{
  const gate = deferred();
  let arbiterStarted = false;
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'rapid', mode: 'auto' },
    storage,
    generationRouter: {
      async generate(roleId, request = {}) {
        if (roleId === 'utilityArbiter') {
          arbiterStarted = true;
          await gate.promise;
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'skip',
              diagnostics: ['blocked-warm']
            }
          };
        }
        throw new Error(`unexpected role ${roleId}`);
      }
    }
  });
  const warmPromise = harness.runtime.warmRapidScene({ reason: 'unit-warming-persist' });
  await waitUntil(() => arbiterStarted, 'Rapid warm Arbiter did not start');
  const view = harness.runtime.view();
  assertEqual(view.rapidWarm.status, 'warming', 'runtime view exposes warming state');
  const cache = await storage.loadSceneCache(view.lastSnapshot.chatKey, view.lastSnapshot.sceneKey);
  const active = cache?.variants?.[cache.activeSourceRevisionHash];
  assertEqual(active?.rapid?.status, 'warming', 'scene cache persists warming status before provider work completes');
  gate.resolve();
  await warmPromise;
}

{
  const gate = deferred();
  let arbiterStarted = false;
  const roleCalls = [];
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'rapid', mode: 'auto' },
    rapidWarmJoinWaitMs: 1,
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          if (!arbiterStarted) {
            arbiterStarted = true;
            await gate.promise;
            return {
              ok: true,
              data: {
                schema: UTILITY_ARBITER_SCHEMA,
                snapshotHash: request.snapshotHash,
                action: 'skip',
                diagnostics: ['late-warm']
              }
            };
          }
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              sceneStatus: 'same-scene',
              promptFootprint: 'normal',
              cardJobs: [],
              reasonerDecision: { mode: 'skip', reason: 'warm timeout standard', signals: [] },
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              diagnostics: ['standard-after-warm-timeout']
            }
          };
        }
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'Standard guidance after Rapid warm timeout.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['timeout-guidance']
            }
          };
        }
        throw new Error(`unexpected role ${roleId}`);
      }
    }
  });
  const warmPromise = harness.runtime.warmRapidScene({ reason: 'unit-timeout' });
  await waitUntil(() => arbiterStarted, 'Rapid warm Arbiter did not start before timeout test');
  const result = await harness.runtime.prepareForGeneration({ userMessage: 'Continue before warm finishes.' });
  assertEqual(result.ok, true, 'foreground generation completes after Rapid warm timeout');
  assertEqual(result.packet.diagnostics.pipelineMode, 'standard', 'Rapid warm timeout falls back to Standard');
  assert(result.plan.diagnostics.includes('rapid-warm-miss:warm-timeout'), 'timeout reason is visible in Standard diagnostics');
  assertEqual(harness.runtime.view().rapidWarm.status, 'missed', 'runtime view exposes Rapid warm miss after timeout');
  assertEqual(harness.runtime.view().rapidWarm.reasonCode, 'warm-timeout', 'runtime view exposes Rapid warm timeout reason');
  assert(Number(harness.runtime.view().rapidWarm.elapsedMs) >= 0, 'Rapid warm view exposes elapsed milliseconds');
  const waitingActivity = harness.activity.history().find((event) => event.phase === 'rapidWarmWaiting');
  assert(waitingActivity, 'Rapid timeout activity history records wait stage');
  assertEqual(waitingActivity.detail.joinWaitMs, 1, 'Rapid wait activity records configured join wait');
  const timeoutActivity = harness.activity.history().find((event) => event.phase === 'rapidWarmMissStandard');
  assert(timeoutActivity, 'Rapid timeout activity history records warm miss stage');
  assertEqual(timeoutActivity.detail.reasonCode, 'warm-timeout', 'Rapid timeout activity exposes reason code');
  assertEqual(timeoutActivity.detail.joinAttempted, true, 'Rapid timeout activity records join attempt');
  assertEqual(timeoutActivity.detail.joinTimedOut, true, 'Rapid timeout activity records timeout');
  assertEqual(timeoutActivity.detail.activeWarmRunPresent, true, 'Rapid timeout activity records active warm run presence');
  gate.resolve();
  await warmPromise;
  assert(roleCalls.filter((roleId) => roleId === 'utilityArbiter').length >= 2, 'timeout test runs warm Arbiter and Standard Arbiter');
}

{
  const { snapshot, baseSourceRevisionHash } = rapidWarmSnapshotFixture();
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  const warmCache = rapidWarmCacheFixture({ cardId: 'warm-card-1', baseSourceRevisionHash });
  await storage.saveSceneCache(snapshot.chatKey, snapshot.sceneKey, warmCache);
  const roleCalls = [];
  const harness = createRuntimeHarness({
    settings: {
      pipelineMode: 'rapid',
      mode: 'auto',
      retention: { sourceVariantsPerScene: 12, runJournalEntries: 12 },
      providers: {
        reasoner: {
          enabled: true,
          source: 'openai-compatible',
          openAICompatible: { baseUrl: 'https://reasoner.changed/v1', model: 'changed-reasoner' },
          temperature: 0.1,
          topP: 1,
          maxTokens: 4096
        }
      }
    },
    snapshot,
    storage,
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'rapidTurnDelta') {
          return {
            ok: true,
            data: {
              schema: 'recursion.rapidTurnDelta.v2',
              snapshotHash: request.snapshotHash,
              baseSourceRevisionHash: request.baseSourceRevisionHash,
              turnSourceRevisionHash: request.turnSourceRevisionHash,
              selectedCardIds: ['warm-card-1'],
              turnGuidanceText: 'UNRELATED_SETTINGS_MARKER still use Rapid.',
              guardrailCardIds: [],
              packetInstructions: [],
              backgroundRefreshRequests: [],
              mandatoryMissingCards: [],
              escalateToStandard: false,
              diagnostics: ['unrelated-settings-rapid']
            }
          };
        }
        throw new Error(`unexpected unrelated settings role ${roleId}`);
      }
    }
  });
  const result = await harness.runtime.prepareForGeneration({ userMessage: 'Use warm deck after unrelated setting drift.' });
  assertEqual(result.ok, true, 'Rapid succeeds after unrelated setting drift');
  assertEqual(result.packet.diagnostics.pipelineMode, 'rapid', 'unrelated retention/reasoner settings do not invalidate Rapid warm deck');
  assertDeepEqual(roleCalls, ['rapidTurnDelta'], 'unrelated setting drift does not run Standard');
}

{
  const { snapshot, baseSourceRevisionHash } = rapidWarmSnapshotFixture();
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  const warmCache = rapidWarmCacheFixture({ cardId: 'warm-card-1', baseSourceRevisionHash });
  await storage.saveSceneCache(snapshot.chatKey, snapshot.sceneKey, warmCache);
  const roleCalls = [];
  const harness = createRuntimeHarness({
    settings: {
      pipelineMode: 'rapid',
      mode: 'auto',
      providers: {
        utility: {
          enabled: true,
          source: 'openai-compatible',
          openAICompatible: { baseUrl: 'https://utility.changed/v1', model: 'changed-utility' },
          temperature: 0.3,
          topP: 1,
          maxTokens: 4096
        }
      }
    },
    snapshot,
    storage,
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'refresh-cards',
              sceneStatus: 'same-scene',
              promptFootprint: 'normal',
              cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Utility drift standard fallback.' }],
              reasonerDecision: { mode: 'skip', reason: 'utility drift standard fallback', signals: [] },
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              diagnostics: ['standard-after-utility-drift']
            }
          };
        }
        if (roleId === 'sceneFrameCard') return cardProviderResponse(roleId, request, 'utility drift standard card.');
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'UTILITY_DRIFT_STANDARD_MARKER rebuild after Utility change.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['utility-drift-guidance']
            }
          };
        }
        throw new Error(`unexpected utility drift role ${roleId}`);
      }
    }
  });
  const result = await harness.runtime.prepareForGeneration({ userMessage: 'Use changed Utility settings.' });
  assertEqual(result.ok, true, 'Rapid Utility drift falls back through Standard');
  assertEqual(result.packet.diagnostics.pipelineMode, 'standard', 'Utility drift invalidates the Rapid warm deck');
  assert(!roleCalls.includes('rapidTurnDelta'), 'Utility drift does not reuse the old Rapid artifact');
  assert(roleCalls.includes('utilityArbiter'), 'Utility drift runs Standard Arbiter');
  assert(result.plan.diagnostics.includes('rapid-warm-miss:settings-mismatch'), 'Utility drift records a Rapid settings mismatch');
}

{
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'rapid', mode: 'auto' },
    storage,
    generationRouter: {
      async generate(roleId) {
        if (roleId === 'utilityArbiter') throw new Error('Bearer rapid-warm-secret');
        throw new Error(`unexpected role ${roleId}`);
      }
    }
  });
  const result = await harness.runtime.warmRapidScene({ reason: 'unit-failure-persist' });
  assertEqual(result.reason, 'rapid-warm-failed', 'Rapid warm provider failure is reported');
  const view = harness.runtime.view();
  assertEqual(view.rapidWarm.status, 'failed', 'runtime view exposes failed Rapid warm state');
  const cache = await storage.loadSceneCache(view.lastSnapshot.chatKey, view.lastSnapshot.sceneKey);
  const active = cache?.variants?.[cache.activeSourceRevisionHash];
  assertEqual(active?.rapid?.status, 'failed', 'scene cache persists failed Rapid warm status');
  assertEqual(active?.rapid?.failureReasonCode, 'warm-failed', 'failed Rapid warm persists reason code');
  assertNoSecretText(active?.rapid, 'failed Rapid warm artifact');
}

{
  const gate = deferred();
  let arbiterStarted = false;
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'rapid', mode: 'auto' },
    generationRouter: {
      async generate(roleId, request = {}) {
        if (roleId === 'utilityArbiter') {
          arbiterStarted = true;
          await gate.promise;
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'skip',
              diagnostics: ['settings-aborted-warm']
            }
          };
        }
        throw new Error(`unexpected role ${roleId}`);
      }
    }
  });
  const warmPromise = harness.runtime.warmRapidScene({ reason: 'unit-settings-abort' });
  await waitUntil(() => arbiterStarted, 'Rapid warm Arbiter did not start before settings abort');
  await harness.runtime.updateSettings({ strength: 'strong' });
  const view = harness.runtime.view();
  assertEqual(view.rapidWarm.status, 'stale', 'settings changes mark active Rapid warm stale');
  assertEqual(view.rapidWarm.reasonCode, 'settings-mismatch', 'settings changes expose Rapid warm stale reason');
  gate.resolve();
  const warmResult = await warmPromise;
  assertEqual(warmResult.superseded, true, 'settings changes supersede active Rapid warm run');
}

{
  const { snapshot, baseSourceRevisionHash } = rapidWarmSnapshotFixture();
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  await storage.saveSceneCache(snapshot.chatKey, snapshot.sceneKey, rapidWarmCacheFixture({ cardId: 'warm-card-1', baseSourceRevisionHash }));
  const roleCalls = [];
  let rapidTurnDeltaRequest = null;
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'rapid', mode: 'auto' },
    snapshot,
    storage,
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'rapidTurnDelta') {
          rapidTurnDeltaRequest = request;
          return {
            ok: true,
            data: {
              schema: 'recursion.rapidTurnDelta.v2',
              snapshotHash: request.snapshotHash,
              baseSourceRevisionHash: request.baseSourceRevisionHash,
              turnSourceRevisionHash: request.turnSourceRevisionHash,
              selectedCardIds: ['warm-card-1'],
              turnGuidanceText: 'TURN_GUIDANCE_MARKER the user tests the hatch now.',
              packetInstructions: ['Keep hatch access constrained.'],
              guardrailCardIds: ['warm-card-1'],
              backgroundRefreshRequests: [],
              mandatoryMissingCards: [],
              escalateToStandard: false,
              diagnostics: ['rapid-warm-v2']
            }
          };
        }
        throw new Error(`unexpected foreground role ${roleId}`);
      }
    }
  });
  const result = await harness.runtime.prepareForGeneration({ userMessage: 'Try the hatch.' });
  assertEqual(result.ok, true, 'Rapid foreground installs from warm deck');
  assert(roleCalls.includes('rapidTurnDelta'), 'Rapid foreground calls turn delta');
  assert(!roleCalls.includes('utilityArbiter'), 'Rapid warm foreground does not call full Arbiter');
  assertEqual(harness.installed.length, 1, 'Rapid foreground installs one prompt packet');
  assert(rapidTurnDeltaRequest.prompt.includes('The hatch stays sealed until opened.'), 'Rapid foreground receives full raw selected cards');
  assert(rapidTurnDeltaRequest.prompt.includes('Warm provider guidance.'), 'Rapid foreground receives warm guidance');
  assert(rapidTurnDeltaRequest.prompt.includes('past tense, third-person-limited POV'), 'Rapid foreground receives story form');
  assert(result.packet.sections.guidance.includes('Warm provider guidance.'), 'Rapid packet includes warm guidance');
  assert(result.packet.sections.guidance.includes('TURN_GUIDANCE_MARKER'), 'Rapid packet includes turn guidance');
  assert(result.packet.sections.cardEvidence.includes('The hatch stays sealed until opened.'), 'Rapid packet includes full raw card evidence');
  assertEqual(result.packet.diagnostics.pipelineMode, 'rapid', 'Rapid packet records Rapid pipeline');
  assertEqual(result.packet.diagnostics.rapidPath, 'warm-v2', 'Rapid packet records warm-v2 path');
  assertEqual(result.packet.storyForm.tense, 'past', 'Rapid packet stores warm story tense');
  assertEqual(result.packet.storyForm.pov, 'third-person-limited', 'Rapid packet stores warm story pov');
  assertNoSecretText(result.packet, 'Rapid packet');
}

{
  const { snapshot, baseSourceRevisionHash } = rapidWarmSnapshotFixture();
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  await storage.saveSceneCache(snapshot.chatKey, snapshot.sceneKey, rapidWarmCacheFixture({ cardId: 'warm-card-1', baseSourceRevisionHash }));
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'rapid', mode: 'auto' },
    snapshot,
    storage,
    generationRouter: {
      async generate(roleId, request = {}) {
        if (roleId === 'rapidTurnDelta') {
          return {
            ok: true,
            data: {
              schema: 'recursion.rapidTurnDelta.v2',
              snapshotHash: request.snapshotHash,
              baseSourceRevisionHash: request.baseSourceRevisionHash,
              turnSourceRevisionHash: request.turnSourceRevisionHash,
              selectedCardIds: ['warm-card-1'],
              turnGuidanceText: '',
              guardrailCardIds: [],
              packetInstructions: ['Use warm guidance only.'],
              backgroundRefreshRequests: [],
              mandatoryMissingCards: [],
              escalateToStandard: false,
              diagnostics: ['warm-guidance-only']
            }
          };
        }
        throw new Error(`unexpected warm-guidance-only role ${roleId}`);
      }
    }
  });
  const result = await harness.runtime.prepareForGeneration({ userMessage: 'Continue with warm guidance only.' });
  assertEqual(result.ok, true, 'Rapid accepts packet instructions without turn guidance prose');
  assertEqual(result.packet.diagnostics.pipelineMode, 'rapid', 'packet-instruction-only delta remains Rapid');
}

{
  const { snapshot, baseSourceRevisionHash } = rapidWarmSnapshotFixture();
  const pendingText = 'The pending user message is already visible in the host snapshot.';
  const hostSnapshot = {
    ...snapshot,
    latestMesId: 3,
    messages: [
      ...snapshot.messages,
      { mesid: 3, role: 'user', text: pendingText, textHash: hashJson(pendingText), visible: true }
    ],
    sourceRevisionHash: sourceFingerprintForMessages([
      ...snapshot.messages,
      { mesid: 3, role: 'user', text: pendingText, textHash: hashJson(pendingText), visible: true }
    ], 2, 3),
    turnFingerprint: 'rapid-host-visible-pending-turn'
  };
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  await storage.saveSceneCache(snapshot.chatKey, snapshot.sceneKey, rapidWarmCacheFixture({ cardId: 'warm-card-1', baseSourceRevisionHash }));
  const roleCalls = [];
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'rapid', mode: 'auto' },
    snapshot: hostSnapshot,
    storage,
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'rapidTurnDelta') {
          return {
            ok: true,
            data: {
              schema: 'recursion.rapidTurnDelta.v2',
              snapshotHash: request.snapshotHash,
              baseSourceRevisionHash: request.baseSourceRevisionHash,
              turnSourceRevisionHash: request.turnSourceRevisionHash,
              selectedCardIds: ['warm-card-1'],
              turnGuidanceText: 'HOST_VISIBLE_PENDING_MARKER use warm deck despite visible pending user.',
              packetInstructions: [],
              guardrailCardIds: ['warm-card-1'],
              backgroundRefreshRequests: [],
              mandatoryMissingCards: [],
              escalateToStandard: false,
              diagnostics: ['host-visible-pending']
            }
          };
        }
        throw new Error(`unexpected host-visible pending role ${roleId}`);
      }
    }
  });
  const result = await harness.runtime.prepareForGeneration({ userMessage: { text: pendingText, mesid: 3 } });
  assertEqual(result.ok, true, 'Rapid foreground handles host-visible pending user messages');
  assertEqual(result.packet.diagnostics.rapidPath, 'warm-v2', 'host-visible pending user still uses warm-v2');
  assertDeepEqual(roleCalls, ['rapidTurnDelta'], 'host-visible pending user does not rerun Standard pipeline');
  assert(result.packet.sections.guidance.includes('HOST_VISIBLE_PENDING_MARKER'), 'host-visible pending Rapid delta reaches packet');
}

{
  const message0 = {
    mesid: 0,
    role: 'user',
    text: 'I push open the archive door and ask Mara about the captain.',
    textHash: hashJson('I push open the archive door and ask Mara about the captain.'),
    visible: true
  };
  const assistant1 = {
    mesid: 1,
    role: 'assistant',
    text: 'Mara stiffens in the candlelight as the guards pass nearby.',
    textHash: hashJson('Mara stiffens in the candlelight as the guards pass nearby.'),
    visible: true
  };
  const pendingText = 'What does Mara say next?';
  const pending2 = {
    mesid: 2,
    role: 'user',
    text: pendingText,
    textHash: hashJson(pendingText),
    visible: true
  };
  const olderHash = sourceFingerprintForMessages([message0], 0, 0);
  const warmHash = sourceFingerprintForMessages([message0, assistant1], 0, 1);
  const hostSnapshot = {
    chatId: 'Rapid Alternate Sparse Chat',
    chatKey: 'rapid-alternate-sparse-chat',
    sceneKey: 'rapid-alternate-sparse-scene',
    sceneFingerprint: 'rapid-alternate-sparse-scene-fp',
    turnFingerprint: 'rapid-alternate-sparse-turn',
    sourceRevisionHash: sourceFingerprintForMessages([message0, pending2], 0, 2),
    latestMesId: 2,
    messages: [message0, pending2]
  };
  const cacheContracts = cacheContractVersions({ pipelineMode: 'rapid', mode: 'auto' });
  const rapidContracts = rapidWarmContractVersions({ pipelineMode: 'rapid', mode: 'auto' });
  const cache = {
    cacheState: 'active',
    versions: cacheContracts,
    activeSourceRevisionHash: warmHash,
    variantOrder: [olderHash, warmHash],
    variants: {
      [olderHash]: {
        sourceRevisionHash: olderHash,
        cards: []
      },
      [warmHash]: {
        sourceRevisionHash: warmHash,
        cards: [{
          id: 'warm-card-sparse-assistant',
          family: 'Active Cast',
          role: 'activeCastCard',
          promptText: 'Mara is present, tense, and constrained by nearby guards.',
          evidenceRefs: ['message:0', 'message:1'],
          source: {
            chatId: 'rapid-alternate-sparse-chat',
            firstMesId: 0,
            lastMesId: 1,
            fingerprint: warmHash,
            snapshotHash: warmHash,
            sourceRevisionHash: warmHash
          },
          freshness: {
            sourceFingerprint: warmHash,
            sourceRevisionHash: warmHash
          }
        }],
        rapid: {
          pipelineVersion: 2,
          status: 'ready',
          warmArtifactId: 'rapid-warm-sparse-assistant',
          baseSourceRevisionHash: warmHash,
          baseSnapshotHash: hashJson({ sourceRevisionHash: warmHash }),
          selectedCardIds: ['warm-card-sparse-assistant'],
          cardIds: ['warm-card-sparse-assistant'],
          guidance: {
            schema: 'recursion.guidanceComposer.v1',
            status: 'used',
            text: 'Use the warmed Mara/guards pressure.',
            sourceCardIds: ['warm-card-sparse-assistant'],
            guardrailCardIds: ['warm-card-sparse-assistant'],
            diagnostics: ['sparse-assistant-warm']
          },
          storyForm: UNKNOWN_STORY_FORM,
          settingsHash: rapidContracts.settingsHash,
          providerContractHash: rapidContracts.providerContractHash,
          cardCatalogHash: rapidContracts.cardCatalogHash,
          promptContractHash: rapidContracts.promptContractHash,
          diagnostics: ['rapid-warm-ready']
        }
      }
    }
  };
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  await storage.saveSceneCache(hostSnapshot.chatKey, hostSnapshot.sceneKey, cache);
  const roleCalls = [];
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'rapid', mode: 'auto' },
    snapshot: hostSnapshot,
    storage,
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'rapidTurnDelta') {
          return {
            ok: true,
            data: {
              schema: 'recursion.rapidTurnDelta.v2',
              snapshotHash: request.snapshotHash,
              baseSourceRevisionHash: request.baseSourceRevisionHash,
              turnSourceRevisionHash: request.turnSourceRevisionHash,
              selectedCardIds: ['warm-card-sparse-assistant'],
              turnGuidanceText: 'SPARSE_ASSISTANT_WARM_MARKER reuse warm deck.',
              packetInstructions: [],
              guardrailCardIds: ['warm-card-sparse-assistant'],
              backgroundRefreshRequests: [],
              mandatoryMissingCards: [],
              escalateToStandard: false,
              diagnostics: ['sparse-assistant-rapid']
            }
          };
        }
        throw new Error(`unexpected sparse assistant warm role ${roleId}`);
      }
    }
  });
  const result = await harness.runtime.prepareForGeneration({ userMessage: { text: pendingText, mesid: 2 } });
  assertEqual(result.ok, true, 'Rapid foreground can use alternate ready warm variant when host snapshot omits cached assistant');
  assertEqual(result.packet.diagnostics.rapidPath, 'warm-v2', 'sparse assistant alternate warm uses Rapid path');
  assertDeepEqual(roleCalls, ['rapidTurnDelta'], 'sparse assistant alternate warm does not rerun Standard pipeline');
  assert(result.packet.sections.guidance.includes('SPARSE_ASSISTANT_WARM_MARKER'), 'sparse assistant Rapid delta reaches packet');
}

{
  let snapshotReads = 0;
  const message0 = {
    mesid: 0,
    role: 'user',
    text: 'I enter the archive and ask Mara about the captain.',
    textHash: hashJson('I enter the archive and ask Mara about the captain.'),
    visible: true
  };
  const staleAssistant1 = {
    mesid: 1,
    role: 'assistant',
    text: 'Stale hook payload assistant text.',
    textHash: hashJson('Stale hook payload assistant text.'),
    visible: true
  };
  const finalAssistant1 = {
    mesid: 1,
    role: 'assistant',
    text: 'Final saved assistant text used by the Rapid warm deck.',
    textHash: hashJson('Final saved assistant text used by the Rapid warm deck.'),
    visible: true
  };
  const pendingText = 'What does Mara say now?';
  const pending2 = {
    mesid: 2,
    role: 'user',
    text: pendingText,
    textHash: hashJson(pendingText),
    visible: true
  };
  const staleHash = sourceFingerprintForMessages([message0, staleAssistant1], 0, 1);
  const warmHash = sourceFingerprintForMessages([message0, finalAssistant1], 0, 1);
  const initialSnapshot = {
    chatId: 'rapid-warm-recheck-chat',
    chatKey: 'rapid-warm-recheck-chat',
    sceneKey: 'rapid-warm-recheck-scene',
    sceneFingerprint: 'rapid-warm-recheck-scene-fp',
    turnFingerprint: 'rapid-warm-recheck-turn-stale',
    sourceRevisionHash: sourceFingerprintForMessages([message0, staleAssistant1, pending2], 0, 2),
    latestMesId: 2,
    messages: [message0, staleAssistant1, pending2]
  };
  const currentSnapshot = {
    ...initialSnapshot,
    turnFingerprint: 'rapid-warm-recheck-turn-current',
    sourceRevisionHash: sourceFingerprintForMessages([message0, finalAssistant1, pending2], 0, 2),
    messages: [message0, finalAssistant1, pending2]
  };
  const cacheContracts = cacheContractVersions({ pipelineMode: 'rapid', mode: 'auto' });
  const rapidContracts = rapidWarmContractVersions({ pipelineMode: 'rapid', mode: 'auto' });
  const cache = {
    cacheState: 'active',
    versions: cacheContracts,
    activeSourceRevisionHash: warmHash,
    variantOrder: [warmHash],
    variants: {
      [warmHash]: {
        sourceRevisionHash: warmHash,
        cards: [{
          id: 'warm-card-recheck-current-base',
          family: 'Scene Frame',
          role: 'sceneFrameCard',
          promptText: 'Mara answers in the current saved archive scene.',
          evidenceRefs: ['message:0', 'message:1'],
          source: {
            chatId: 'rapid-warm-recheck-chat',
            firstMesId: 0,
            lastMesId: 1,
            fingerprint: warmHash,
            snapshotHash: warmHash,
            sourceRevisionHash: warmHash
          },
          freshness: {
            sourceFingerprint: warmHash,
            sourceRevisionHash: warmHash
          }
        }],
        rapid: {
          pipelineVersion: 2,
          status: 'ready',
          warmArtifactId: 'rapid-warm-recheck-current-base',
          baseSourceRevisionHash: warmHash,
          selectedCardIds: ['warm-card-recheck-current-base'],
          cardIds: ['warm-card-recheck-current-base'],
          guidance: {
            schema: 'recursion.guidanceComposer.v1',
            status: 'used',
            text: 'Use the current saved warm base.',
            sourceCardIds: ['warm-card-recheck-current-base'],
            guardrailCardIds: ['warm-card-recheck-current-base'],
            diagnostics: ['current-base-warm']
          },
          storyForm: UNKNOWN_STORY_FORM,
          settingsHash: rapidContracts.settingsHash,
          providerContractHash: rapidContracts.providerContractHash,
          cardCatalogHash: rapidContracts.cardCatalogHash,
          promptContractHash: rapidContracts.promptContractHash,
          diagnostics: ['rapid-warm-ready']
        }
      }
    }
  };
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  await storage.saveSceneCache(initialSnapshot.chatKey, initialSnapshot.sceneKey, cache);
  const roleCalls = [];
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'rapid', mode: 'auto' },
    snapshot: () => {
      snapshotReads += 1;
      return snapshotReads === 1 ? initialSnapshot : currentSnapshot;
    },
    storage,
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'rapidTurnDelta') {
          return {
            ok: true,
            data: {
              schema: 'recursion.rapidTurnDelta.v2',
              snapshotHash: request.snapshotHash,
              baseSourceRevisionHash: request.baseSourceRevisionHash,
              turnSourceRevisionHash: request.turnSourceRevisionHash,
              selectedCardIds: ['warm-card-recheck-current-base'],
              turnGuidanceText: 'CURRENT_BASE_WARM_MARKER install after recheck.',
              packetInstructions: [],
              guardrailCardIds: ['warm-card-recheck-current-base'],
              backgroundRefreshRequests: [],
              mandatoryMissingCards: [],
              escalateToStandard: false,
              diagnostics: ['current-base-rapid']
            }
          };
        }
        throw new Error(`unexpected current-base warm role ${roleId}`);
      }
    }
  });
  const result = await harness.runtime.prepareForGeneration({ userMessage: { text: pendingText, mesid: 2 } });
  assertEqual(staleHash !== warmHash, true, 'test fixture uses a stale hook prefix distinct from warm base');
  assertEqual(result.ok, true, 'Rapid install tolerates stale hook prefix when current prefix matches warm base');
  assertEqual(result.packet.diagnostics.rapidPath, 'warm-v2', 'current-base recheck keeps Rapid path');
  assertDeepEqual(roleCalls, ['rapidTurnDelta'], 'current-base recheck does not rerun Standard pipeline');
  assert(result.packet.sections.guidance.includes('CURRENT_BASE_WARM_MARKER'), 'current-base Rapid delta reaches packet');
}

{
  const roleCalls = [];
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'rapid', mode: 'auto' },
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'refresh-cards',
              sceneStatus: 'same-scene',
              promptFootprint: 'normal',
              cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Warm miss standard.' }],
              reasonerDecision: { mode: 'skip', reason: 'warm miss standard', signals: [] },
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              diagnostics: ['standard-after-warm-miss']
            }
          };
        }
        if (roleId === 'sceneFrameCard') return cardProviderResponse(roleId, request, 'raw card marker after warm miss.');
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'STANDARD_GUIDANCE_MARKER use raw cards as evidence.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['standard-guidance']
            }
          };
        }
        throw new Error(`unexpected role ${roleId}`);
      }
    }
  });
  const result = await harness.runtime.prepareForGeneration({ userMessage: 'Try the hatch.' });
  assertEqual(result.ok, true, 'Rapid warm miss escalates and Standard installs');
  assert(!roleCalls.includes('rapidFastStartPack'), 'warm miss does not use summary fast-start');
  assert(roleCalls.includes('utilityArbiter'), 'warm miss runs Standard arbiter');
  assertEqual(result.packet.diagnostics.pipelineMode, 'standard', 'warm miss installs Standard packet');
  assert(result.plan.diagnostics.includes('rapid-warm-miss-standard'), 'warm miss diagnostic recorded');
}

{
  const roleCalls = [];
  const { snapshot, baseSourceRevisionHash } = rapidWarmSnapshotFixture();
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  const warmCache = rapidWarmCacheFixture({ cardId: 'warm-card-1', baseSourceRevisionHash });
  warmCache.variants[baseSourceRevisionHash].cards[0].source.firstMesId = 0;
  warmCache.variants[baseSourceRevisionHash].cards[0].source.lastMesId = 2;
  await storage.saveSceneCache(snapshot.chatKey, snapshot.sceneKey, warmCache);
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'rapid', mode: 'auto' },
    snapshot,
    storage,
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'rapidTurnDelta') {
          return {
            ok: true,
            data: {
              schema: 'recursion.wrongSchema.v1',
              snapshotHash: request.snapshotHash,
              baseSourceRevisionHash: request.baseSourceRevisionHash,
              turnSourceRevisionHash: request.turnSourceRevisionHash,
              selectedCardIds: ['warm-card-1'],
              turnGuidanceText: 'Wrong schema should not be trusted.',
              escalateToStandard: false
            }
          };
        }
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              sceneStatus: 'same-scene',
              promptFootprint: 'compact',
              cardJobs: [],
              budgets: { targetBriefTokens: 500, maxCards: 6 },
              reasonerDecision: { mode: 'skip', reason: 'unit standard escalation' },
              diagnostics: []
            }
          };
        }
        throw new Error(`unexpected role ${roleId}`);
      }
    }
  });
  const result = await harness.runtime.prepareForGeneration({ userMessage: 'Try the hatch.' });
  assertEqual(result.ok, true, 'invalid Rapid schema escalates and Standard installs');
  assert(roleCalls.includes('rapidTurnDelta'), 'Rapid tries turn delta before schema escalation');
  assert(roleCalls.includes('utilityArbiter'), 'invalid Rapid schema continues through Standard Arbiter');
  assert(result.plan.diagnostics.includes('rapid-escalated-standard:invalid-provider-output'), 'plan records invalid Rapid output escalation');
}

{
  const roleCalls = [];
  const { snapshot, baseSourceRevisionHash } = rapidWarmSnapshotFixture();
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  await storage.saveSceneCache(snapshot.chatKey, snapshot.sceneKey, rapidWarmCacheFixture({ cardId: 'warm-card-1', baseSourceRevisionHash }));
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'rapid', mode: 'auto' },
    snapshot,
    storage,
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'rapidTurnDelta') {
          return {
            ok: true,
            data: {
              schema: 'recursion.rapidTurnDelta.v2',
              snapshotHash: request.snapshotHash,
              baseSourceRevisionHash: request.baseSourceRevisionHash,
              turnSourceRevisionHash: request.turnSourceRevisionHash,
              selectedCardIds: ['warm-card-1'],
              turnGuidanceText: 'Do not use this when mandatory card is missing.',
              guardrailCardIds: [],
              packetInstructions: [],
              backgroundRefreshRequests: [],
              mandatoryMissingCards: [{ family: 'Scene Constraints', reason: 'Need safety boundary.' }],
              escalateToStandard: false,
              diagnostics: ['mandatory-gap-delta']
            }
          };
        }
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              sceneStatus: 'same-scene',
              promptFootprint: 'compact',
              cardJobs: [],
              budgets: { targetBriefTokens: 500, maxCards: 6 },
              reasonerDecision: { mode: 'skip', reason: 'mandatory gap standard fallback' },
              diagnostics: []
            }
          };
        }
        throw new Error(`unexpected mandatory gap role ${roleId}`);
      }
    }
  });
  const result = await harness.runtime.prepareForGeneration({ userMessage: 'Try the hatch safely.' });
  assertEqual(result.ok, true, 'mandatory Rapid gap escalates and Standard installs');
  assert(roleCalls.includes('rapidTurnDelta'), 'mandatory gap test tries Rapid delta first');
  assert(roleCalls.includes('utilityArbiter'), 'mandatory gap continues through Standard Arbiter');
  assert(result.plan.diagnostics.includes('rapid-escalated-standard:mandatory-gap'), 'plan records mandatory gap escalation');
  assert(result.plan.diagnostics.includes('rapid-mandatory-gap:Scene Constraints'), 'plan records first mandatory gap family');
}

{
  const calls = [];
  const { snapshot, baseSourceRevisionHash } = rapidWarmSnapshotFixture();
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  await storage.saveSceneCache(snapshot.chatKey, snapshot.sceneKey, rapidWarmCacheFixture({ cardId: 'warm-card-1', baseSourceRevisionHash }));
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'rapid', mode: 'auto' },
    snapshot,
    storage,
    rapidHedgeDelayMs: 1,
    generationRouter: {
      async generate(roleId, request = {}) {
        calls.push({ roleId, hedge: request.rapidHedgeSource });
        if (roleId !== 'rapidTurnDelta') throw new Error(`unexpected role ${roleId}`);
        if (request.rapidHedgeSource === 'primary') {
          await delay(20);
          return { ok: false, error: { code: 'slow-invalid', message: 'primary invalid' } };
        }
        return {
          ok: true,
          data: {
            schema: 'recursion.rapidTurnDelta.v2',
            snapshotHash: request.snapshotHash,
            baseSourceRevisionHash: request.baseSourceRevisionHash,
            turnSourceRevisionHash: request.turnSourceRevisionHash,
            selectedCardIds: ['warm-card-1'],
            turnGuidanceText: 'Backup turn guidance.',
            guardrailCardIds: ['warm-card-1'],
            packetInstructions: [],
            backgroundRefreshRequests: [],
            mandatoryMissingCards: [],
            escalateToStandard: false,
            diagnostics: ['rapid-hedge-backup', { code: 'rapid-object-diagnostic' }]
          }
        };
      }
    }
  });
  const result = await harness.runtime.prepareForGeneration({ userMessage: 'Use backup hedge.' });
  assertEqual(result.ok, true, 'Rapid hedge installs from backup');
  assert(calls.some((call) => call.hedge === 'primary'), 'primary hedge call started');
  assert(calls.some((call) => call.hedge === 'backup'), 'backup hedge call started');
  assert(JSON.stringify(result.packet).includes('rapid-hedge-backup'), 'packet diagnostics include backup winner');
  assertNoObjectString(result.packet, 'Rapid object diagnostics do not stringify to object marker');
}

const modelFetchSettingsStore = createSettingsStore({ root: {} });
modelFetchSettingsStore.updateProvider('utility', {
  source: 'openai-compatible',
  openAICompatible: { baseUrl: 'https://runtime-models.example/v1', model: '' },
  apiKey: 'sk-live-secret'
});
const modelFetchCalls = [];
const modelFetchRuntime = createRecursionRuntime({
  settingsStore: modelFetchSettingsStore,
  fetchImpl: async (url, init = {}) => {
    modelFetchCalls.push({ url, init });
    return {
      ok: true,
      status: 200,
      async json() {
        return { data: [{ id: 'runtime-alpha' }, { id: 'runtime-beta', name: 'Runtime Beta' }] };
      }
    };
  }
});
const runtimeModels = await modelFetchRuntime.fetchProviderModels('utility');
assertEqual(runtimeModels.ok, true, 'runtime exposes provider model fetch');
assertDeepEqual(
  runtimeModels.models.map((entry) => [entry.id, entry.label]),
  [
    ['runtime-alpha', 'runtime-alpha'],
    ['runtime-beta', 'Runtime Beta']
  ],
  'runtime provider model fetch returns normalized model list'
);
assertEqual(modelFetchCalls[0].url, 'https://runtime-models.example/v1/models', 'runtime model fetch uses shared /models endpoint');
assert(!JSON.stringify(runtimeModels).includes('sk-live-secret'), 'runtime model fetch result does not expose session key');

async function assertSingleCachedCardUnavailable({ card, snapshot, userMessage, label }) {
  const storage = {
    async loadSceneCache() {
      return {
        versions: cacheContractVersions({ mode: 'auto', reasonerUse: 'off' }),
        cards: [card]
      };
    },
    async saveSceneCache() {
      return {};
    },
    async appendJournal() {
      return {};
    }
  };
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    snapshot,
    generationRouter: {
      async generate(roleId, request) {
        assertEqual(roleId, 'utilityArbiter', `${label}: only utility arbiter should run`);
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'reuse-cache',
            lifecycle: [{ action: 'select', cardId: card.id, reason: label }],
            budgets: { targetBriefTokens: 500, maxCards: 4 },
            diagnostics: [label]
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage });
  const serialized = JSON.stringify({ result, view: runtime.view() });
  assertEqual(result.ok, true, `${label}: stale cache remains fail-soft`);
  assertEqual(result.skipped, true, `${label}: cache is unavailable`);
  assertEqual(result.reason, 'cache-unavailable', `${label}: unavailable reason returned`);
  assertEqual(installed.length, 0, `${label}: prompt is not installed`);
  assert(!serialized.includes(card.promptText), `${label}: stale prompt text is not exposed`);
}

{
  const { runtime, calls, installed, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: localFallbackCardRouter()
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'The lamp breaks.' });
  const view = runtime.view();
  assertEqual(runtime.storage, storage, 'runtime exposes storage repository');
  assertEqual(result.ok, true, 'auto mode returns ok');
  assertEqual(calls.snapshot, 3, 'auto mode reads snapshot and rechecks before compose and install');
  assertEqual(installed.length, 1, 'auto mode installs one prompt');
  assert(view.lastHand.cards.length > 0, 'hand available in view');
  assert(view.lastPacket.sections.cardEvidence.includes('The lamp breaks.'), 'scene frame uses latest visible message');
  assert(!view.lastPacket.sections.cardEvidence.includes('hidden draft'), 'scene frame ignores invisible message');
  assertEqual(view.activity.label, 'Recursion prompt ready.', 'activity settled');
  assert(Array.isArray(view.activityHistory), 'runtime view exposes bounded activity history');
  assert(view.activityHistory.some((event) => event.phase === 'started'), 'activity history includes turn start');
  assert(view.activityHistory.some((event) => event.phase === 'handSelected'), 'activity history includes hand selection');
  assert(
    view.activityHistory.some((event) => event.phase === 'cardProgress'
      && event.detail?.parentStepId === 'utility-card-batch'
      && event.detail?.source === 'fallback'
      && event.detail?.state === 'warning'),
    'activity history includes local fallback card child progress'
  );
  assert(
    view.activityHistory.some((event) => event.phase === 'cardBatchRunning'),
    'local fallback card work is reported as a card batch rather than cache reuse'
  );
  assert(
    !view.activityHistory.some((event) => event.phase === 'cacheReusing'),
    'local fallback card work never reports a cache hit'
  );
  assertNoSecretText(view.activityHistory, 'runtime view activity history');
  assertEqual(view.activeRunId, null, 'active run cleared after auto success');
  const cache = await storage.loadSceneCache(view.lastSnapshot.chatKey, view.lastSnapshot.sceneKey);
  assert(cache.cards.length >= 2, 'scene cache persists fallback cards');
  assertEqual(cache.versions.cardCatalogHash, hashJson(CARD_CATALOG), 'scene cache records card catalog hash');
  assertEqual(cache.versions.promptPacketVersion, 3, 'scene cache records prompt packet contract version');
  assert(cache.versions.promptContractHash, 'scene cache records prompt contract hash');
  assertEqual(cache.versions.promptContractHash, cacheContractVersions(view.settings).promptContractHash, 'scene cache prompt contract hash matches current prompt contract');
  assertEqual(cache.versions.runtimeCacheContractVersion, 1, 'scene cache records runtime cache contract version');
  assertEqual(cache.versions.settingsHash, cacheContractVersions(view.settings).settingsHash, 'scene cache records current settings hash');
  assertEqual(cache.versions.providerContractHash, cacheContractVersions(view.settings).providerContractHash, 'scene cache records provider contract hash');
  const baselineVersions = cacheContractVersions(view.settings);
  const noisyVersions = cacheContractVersions({
    ...view.settings,
    diagnostics: { maxJournalEntries: 500, includeExcerpts: true },
    ui: { viewerOpen: true, progressChildVisibleLimit: 20, progressListVisibleLimit: 80 },
    providers: {
      ...view.settings.providers,
      utility: {
        ...view.settings.providers.utility,
        apiKey: 'sk-version-helper-secret',
        resolvedProviderLabel: 'Noisy utility label',
        resolvedModelLabel: 'Noisy utility model',
        lastTest: { status: 'fail', compactError: 'Bearer version-helper-token' }
      }
    }
  });
  assertEqual(noisyVersions.settingsHash, baselineVersions.settingsHash, 'cache settings hash ignores UI, diagnostics, test labels, and secrets');
  assertNotEqual(
    cacheContractVersions({ mode: 'auto', cardScope: defaultCardScope() }).settingsHash,
    cacheContractVersions({ mode: 'manual', cardScope: scopeWithFamilyDisabled('Environment') }).settingsHash,
    'card scope participates in scene cache contract'
  );
  const changedProviderVersions = cacheContractVersions({
    ...view.settings,
    providers: {
      ...view.settings.providers,
      utility: {
        ...view.settings.providers.utility,
        maxTokens: view.settings.providers.utility.maxTokens + 1
      }
    }
  });
  assert(changedProviderVersions.settingsHash !== baselineVersions.settingsHash, 'cache settings hash changes for cache-relevant provider settings');
  assert(cache.latestHand?.handId, 'scene cache persists latest hand metadata');
  assert(cache.latestHand.cardIds.length > 0, 'scene cache latest hand records selected card ids');
  assert(cache.latestHand.promptPacketHash, 'scene cache latest hand records prompt packet hash');
  assert(!Object.prototype.hasOwnProperty.call(cache.latestHand, 'cards'), 'scene cache latest hand omits raw card objects');
  assert(!JSON.stringify(cache.latestHand).includes(view.lastHand.cards[0].promptText), 'scene cache latest hand omits prompt text');
  assert(cache.cards.some((card) => Number.isFinite(card.source?.firstMesId) && Number.isFinite(card.source?.lastMesId)), 'scene cache cards preserve source message range');
  const journal = await storage.loadRunJournal(view.lastSnapshot.chatKey);
  assertDeepEqual(journal.entries.map((entry) => entry.event), ['hand.selected', 'prompt.installed'], 'auto journals hand before prompt install');
  const handSelected = journal.entries.find((entry) => entry.event === 'hand.selected');
  const promptInstalled = journal.entries.find((entry) => entry.event === 'prompt.installed');
  assert(handSelected, 'hand selection journal entry persisted');
  assert(promptInstalled, 'install journal records success');
  assertEqual(handSelected.details?.handId, view.lastHand.handId, 'hand selection journal records hand id');
  assertEqual(handSelected.details?.selectedCount, view.lastHand.cards.length, 'hand selection journal records selected count');
  assertEqual(handSelected.details?.cards?.length, view.lastHand.cards.length, 'hand selection journal records selected card metadata');
  assertEqual(handSelected.details?.listedCount, view.lastHand.cards.length, 'hand selection journal records listed count');
  assertEqual(handSelected.details?.truncated, false, 'hand selection journal records truncation state');
  assert(handSelected.hashes?.promptPacketHash, 'hand selection journal records prompt packet hash');
  assert(!JSON.stringify(handSelected).includes(view.lastHand.cards[0].promptText), 'hand selection journal omits prompt text');
}

{
  const { runtime, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'refresh-cards',
              cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Need a card.' }],
              budgets: { targetBriefTokens: 500, maxCards: 1 },
              reasonerDecision: { mode: 'skip', reason: 'journal fallback test', signals: [] },
              diagnostics: ['journal-fallback-test']
            }
          };
        }
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: 'wrong-snapshot',
              guidanceText: 'Rejected guidance.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['wrong-snapshot']
            }
          };
        }
        return {
          ok: true,
          roleId,
          data: {
            schema: 'recursion.card.v1',
            role: request.metadata.role,
            family: request.metadata.family,
            snapshotHash: request.snapshotHash,
            items: [{
              promptText: 'Keep the scene frame anchored to the current user action.',
              evidenceRefs: ['message:2']
            }]
          }
        };
      }
    }
  });

  const result = await runtime.prepareForGeneration({ userMessage: 'Persist guidance fallback reason.' });
  const journal = await storage.loadRunJournal(runtime.view().lastSnapshot.chatKey);
  const handEntry = journal.entries.find((entry) => entry.event === 'hand.selected' && entry.runId === result.packet.diagnostics.runId);
  assertEqual(result.packet.diagnostics.guidanceStatus, 'fallback-raw-only', 'runtime packet records guidance fallback');
  assertEqual(handEntry.details.guidanceStatus, 'fallback-raw-only', 'hand journal records guidance fallback status');
  assertEqual(handEntry.details.guidanceFallbackReason, 'snapshot-mismatch', 'hand journal records guidance fallback reason');
}

{
  let activeSwipe = 'a';
  let arbiterCalls = 0;
  let swipeACardId = '';
  const snapshots = {
    a: swipeSnapshot({ text: 'Swipe A answer keeps the candle lit.', swipeId: 0, label: 'a' }),
    b: swipeSnapshot({ text: 'Swipe B answer lets the candle gutter out.', swipeId: 1, label: 'b' })
  };
  const { runtime, installed, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => snapshots[activeSwipe],
    generationRouter: {
      async generate(roleId, request = {}) {
        if (roleId === 'utilityArbiter') {
          arbiterCalls += 1;
          if (arbiterCalls === 3) {
            return {
              ok: true,
              data: {
                schema: UTILITY_ARBITER_SCHEMA,
                snapshotHash: request.snapshotHash,
                action: 'reuse-cache',
                lifecycle: [{ action: 'select', cardId: swipeACardId, reason: 'active swipe returned to cached A variant' }],
                budgets: { targetBriefTokens: 500, maxCards: 6 },
                diagnostics: ['swipe-a-return-reuse']
              }
            };
          }
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              cardJobs: [{ role: 'sceneFrameCard', family: 'Scene Frame', priority: 100 }],
              budgets: { targetBriefTokens: 500, maxCards: 6 },
              diagnostics: [`swipe-${activeSwipe}-compose`]
            }
          };
        }
        assertEqual(roleId, 'sceneFrameCard', 'swipe variant test only generates scene frame cards');
        const label = activeSwipe.toUpperCase();
        return {
          ok: true,
          roleId,
          data: {
            schema: 'recursion.card.v1',
            role: 'sceneFrameCard',
            family: 'Scene Frame',
            snapshotHash: request.snapshotHash,
            items: [{
              promptText: `Swipe ${label} cached card guidance.`,
              evidenceRefs: ['message:2'],
              tokenEstimate: 8
            }]
          }
        };
      }
    }
  });
  const userMessage = 'Continue.';
  const first = await runtime.prepareForGeneration({ userMessage });
  assertEqual(first.ok, true, 'swipe A setup installs');
  const preparedSwipeARevision = runtime.view().lastSnapshot.sourceRevisionHash;
  swipeACardId = runtime.view().lastHand.cards[0]?.id || '';
  assert(swipeACardId, 'swipe A setup selects a card');
  assert(JSON.stringify(installed.at(-1)).includes('Swipe A cached card guidance.'), 'swipe A prompt uses A card');
  activeSwipe = 'b';
  await runtime.handleSourceChanged({ eventName: 'message_swiped', messageId: 2 });
  const second = await runtime.prepareForGeneration({ userMessage });
  assertEqual(second.ok, true, 'swipe B run installs');
  assert(JSON.stringify(installed.at(-1)).includes('Swipe B cached card guidance.'), 'swipe B prompt uses B card');
  assert(!JSON.stringify(installed.at(-1)).includes('Swipe A cached card guidance.'), 'swipe B prompt does not reuse A card');
  activeSwipe = 'a';
  await runtime.handleSourceChanged({ eventName: 'message_swiped', messageId: 2 });
  const third = await runtime.prepareForGeneration({ userMessage });
  assertEqual(third.ok, true, 'swipe A return installs');
  assertEqual(third.skipped, undefined, 'swipe A return can reuse active variant');
  const thirdRunId = runtime.view().lastPacket?.diagnostics?.runId;
  assert(
    runtime.view().activityHistory.some((event) => event.runId === thirdRunId && event.phase === 'cacheReusing'),
    'swipe A return emits cacheReusing progress for purple scene deck reuse'
  );
  assert(JSON.stringify(installed.at(-1)).includes('Swipe A cached card guidance.'), 'swipe A return reuses A card');
  assert(!JSON.stringify(installed.at(-1)).includes('Swipe B cached card guidance.'), 'swipe A return does not leak B card');
  const cache = await storage.loadSceneCache(snapshots.a.chatKey, snapshots.a.sceneKey);
  const preparedSwipeBRevision = sourceWindowHash([
    ...snapshots.b.messages,
    { mesid: 3, role: 'user', text: userMessage, textHash: hashJson(userMessage), visible: true }
  ], 2, 3);
  assertEqual(cache.activeSourceRevisionHash, preparedSwipeARevision, 'scene cache marks active swipe revision');
  assert(cache.variants[preparedSwipeARevision], 'scene cache keeps A source variant');
  assert(cache.variants[preparedSwipeBRevision], 'scene cache keeps B source variant');
}

for (const pipelineMode of ['standard', 'rapid', 'fused']) {
  let providerCalls = 0;
  const baseSnapshot = {
    chatId: `same-turn-${pipelineMode}-chat`,
    chatKey: `same-turn-${pipelineMode}-chat`,
    sceneKey: `same-turn-${pipelineMode}-scene`,
    sceneFingerprint: `same-turn-${pipelineMode}-scene-fp`,
    turnFingerprint: `same-turn-${pipelineMode}-turn-fp`,
    latestMesId: 2,
    messages: [
      { mesid: 2, role: 'assistant', text: 'The prior reply waits for a swipe retry.', visible: true }
    ]
  };
  const { runtime, installed } = createRuntimeHarness({
    settings: { pipelineMode, mode: 'auto', reasonerUse: 'off' },
    snapshot: () => baseSnapshot,
    generationRouter: {
      async generate(roleId, request = {}) {
        providerCalls += 1;
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              cardJobs: [{ role: 'sceneFrameCard', family: 'Scene Frame', priority: 100 }],
              budgets: { targetBriefTokens: 500, maxCards: 6 },
              reasonerDecision: { mode: 'skip', reason: 'same turn retry setup', signals: [] },
              diagnostics: ['same-turn-retry-standard']
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
                promptText: 'Same-turn retry card guidance.',
                evidenceRefs: ['message:3'],
                tokenEstimate: 8
              }]
            }
          };
        }
        if (roleId === 'fusedCardBundle') {
          return {
            ok: true,
            data: {
              schema: 'recursion.cardBundle.v1',
              snapshotHash: request.snapshotHash,
              items: [{
                schema: 'recursion.card.v1',
                role: 'sceneFrameCard',
                family: 'Scene Frame',
                promptText: 'Same-turn retry card guidance.',
                evidenceRefs: ['message:3'],
                tokenEstimate: 8
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
              guidanceText: 'Same-turn retry guidance.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['same-turn-retry-guidance']
            }
          };
        }
        throw new Error(`unexpected same-turn retry role ${roleId}`);
      }
    }
  });
  const userMessage = 'Retry this response as another swipe.';
  const first = await runtime.prepareForGeneration({ userMessage });
  assertEqual(first.ok, true, `${pipelineMode} first same-turn run installs`);
  assertEqual(installed.length, 1, `${pipelineMode} first same-turn run installs one packet`);
  const callsAfterFirst = providerCalls;
  const second = await runtime.prepareForGeneration({ userMessage });
  assertEqual(second.ok, true, `${pipelineMode} same-turn retry succeeds`);
  assertEqual(second.reused, true, `${pipelineMode} same-turn retry reuses prior packet`);
  assertEqual(second.reason, 'same-turn-swipe-retry', `${pipelineMode} same-turn retry reports reuse reason`);
  assertEqual(providerCalls, callsAfterFirst, `${pipelineMode} same-turn retry does not call providers again`);
  assertEqual(installed.length, 2, `${pipelineMode} same-turn retry reinstalls the existing packet`);
  assertEqual(installed[0].packetId, installed[1].packetId, `${pipelineMode} same-turn retry keeps packet identity`);
  assertEqual(runtime.view().lastCacheDecision?.kind, 'swipe-packet', `${pipelineMode} same-turn retry exposes swipe cache provenance`);
  assertEqual(runtime.view().lastCacheDecision?.decision, 'hit', `${pipelineMode} same-turn retry exposes cache hit`);
}

for (const pipelineMode of ['standard', 'rapid', 'fused']) {
  let providerCalls = 0;
  const userMessage = 'Retry the latest assistant response as a swipe.';
  const chatId = `latest-assistant-swipe-${pipelineMode}-chat`;
  const initialMessages = [
    { mesid: 10, role: 'user', text: userMessage, textHash: hashJson(userMessage), visible: true }
  ];
  const snapshotFromMessages = (messages) => ({
    chatId,
    chatKey: chatId,
    sceneKey: `latest-assistant-swipe-${pipelineMode}-scene`,
    sceneFingerprint: `latest-assistant-swipe-${pipelineMode}-scene-fp`,
    latestMesId: messages.at(-1)?.mesid || 0,
    messages
  });
  let activeSnapshot = snapshotFromMessages(initialMessages);
  const { runtime, installed, cleared, storage } = createRuntimeHarness({
    settings: {
      pipelineMode,
      mode: 'auto',
      reasonerUse: 'off',
      enhancements: { mode: 'off', applyMode: 'as-swipe', contextMessages: 13 }
    },
    snapshot: () => activeSnapshot,
    generationRouter: {
      async generate(roleId, request = {}) {
        providerCalls += 1;
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              cardJobs: [{ role: 'sceneFrameCard', family: 'Scene Frame', priority: 100 }],
              budgets: { targetBriefTokens: 500, maxCards: 6 },
              reasonerDecision: { mode: 'skip', reason: 'latest assistant swipe setup', signals: [] },
              diagnostics: ['latest-assistant-swipe-setup']
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
                promptText: 'Latest assistant swipe retry card guidance.',
                evidenceRefs: ['message:10'],
                tokenEstimate: 8
              }]
            }
          };
        }
        if (roleId === 'fusedCardBundle') {
          return {
            ok: true,
            data: {
              schema: 'recursion.cardBundle.v1',
              snapshotHash: request.snapshotHash,
              items: [{
                schema: 'recursion.card.v1',
                role: 'sceneFrameCard',
                family: 'Scene Frame',
                promptText: 'Latest assistant swipe retry card guidance.',
                evidenceRefs: ['message:10'],
                tokenEstimate: 8
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
              guidanceText: 'Latest assistant swipe retry guidance.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['latest-assistant-swipe-guidance']
            }
          };
        }
        throw new Error(`unexpected latest assistant swipe role ${roleId}`);
      }
    }
  });
  const first = await runtime.prepareForGeneration({ userMessage, hostGeneration: true });
  assertEqual(first.ok, true, `${pipelineMode} latest-assistant swipe setup installs`);
  assertEqual(installed.length, 1, `${pipelineMode} latest-assistant swipe setup installs one packet`);
  assertEqual(runtime.view().lastBrief?.status, 'ready', `${pipelineMode} latest-assistant swipe setup marks Last Brief ready`);
  const callsAfterFirst = providerCalls;
  const settingUpdate = await runtime.updateSettings({
    enhancements: { mode: 'repair', applyMode: 'as-swipe', contextMessages: 13 }
  });
  assertEqual(settingUpdate.clear, null, `${pipelineMode} enhancement-only setting change does not clear the prepared prompt`);
  assertEqual(cleared.length, 0, `${pipelineMode} enhancement-only setting change does not write empty prompt lanes`);
  const journalAfterSettings = await storage.loadRunJournal(activeSnapshot.chatKey);
  assertEqual(
    journalAfterSettings.entries.some((entry) => entry.event === 'cache.invalidated' && entry.details?.reason === 'settings-changed'),
    false,
    `${pipelineMode} enhancement-only setting change does not invalidate the scene cache`
  );
  activeSnapshot = snapshotFromMessages([
    ...initialMessages,
    {
      mesid: 11,
      role: 'assistant',
      text: 'First assistant response now being swiped.',
      textHash: hashJson('First assistant response now being swiped.'),
      visible: true,
      swipeId: 1,
      swipeCount: 2,
      activeSwipeTextHash: hashJson('Alternate assistant response.')
    }
  ]);
  const second = await runtime.prepareForGeneration({ userMessage: null, hostGeneration: true, generationType: 'swipe' });
  assertEqual(second.ok, true, `${pipelineMode} latest-assistant swipe retry succeeds`);
  assertEqual(second.reused, true, `${pipelineMode} latest-assistant swipe retry reuses previous packet`);
  assertEqual(second.reason, 'same-turn-swipe-retry', `${pipelineMode} latest-assistant swipe retry reports reuse reason`);
  assertEqual(providerCalls, callsAfterFirst, `${pipelineMode} latest-assistant swipe retry does not call providers again`);
  assertEqual(installed.length, 2, `${pipelineMode} latest-assistant swipe retry reinstalls previous packet`);
  assertEqual(installed[0].packetId, installed[1].packetId, `${pipelineMode} latest-assistant swipe retry keeps packet identity`);
  assertEqual(runtime.view().lastBrief?.status, 'ready', `${pipelineMode} latest-assistant swipe reuse restores Last Brief after reinstall`);
  assertEqual(runtime.view().lastBrief?.packetId, installed[0].packetId, `${pipelineMode} latest-assistant swipe reuse restores original packet id`);
  assertEqual(runtime.view().lastSnapshot.latestMesId, 10, `${pipelineMode} latest-assistant swipe retry keeps original user-turn snapshot`);
}

{
  const userText = 'Retry while Editorial is still transforming.';
  const assistantText = 'The team remained seated while Carter questioned the transport pattern.';
  const chatId = 'editorial-overlap-swipe-chat';
  const initialMessages = Array.from({ length: 30 }, (_, index) => ({
    mesid: index,
    role: index === 29 ? 'user' : (index % 2 === 0 ? 'user' : 'assistant'),
    text: index === 29 ? userText : `bounded message ${index}`,
    visible: true
  }));
  const snapshotFromMessages = (messages) => ({
    chatId,
    chatKey: chatId,
    sceneKey: 'editorial-overlap-swipe-scene',
    sceneFingerprint: 'editorial-overlap-swipe-scene-fp',
    latestMesId: messages.at(-1)?.mesid || 0,
    messages: messages.slice(-20)
  });
  let activeSnapshot = snapshotFromMessages(initialMessages);
  let swipeStarting = false;
  let transformerRelease;
  let transformerSignal = null;
  let transformerStarted = false;
  let appendCount = 0;
  const lifecycleEvents = [];
  const providerRoles = [];
  const transformerGate = new Promise((resolve) => { transformerRelease = resolve; });
  const sourceHash = hashJson(assistantText);
  const message = {
    chatKey: chatId,
    messageId: 30,
    swipeId: 0,
    text: assistantText,
    originalHash: sourceHash,
    swipes: [assistantText]
  };
  const { runtime, installed } = createRuntimeHarness({
    settings: {
      pipelineMode: 'fused',
      mode: 'auto',
      reasonerUse: 'off',
      enhancements: { mode: 'recompose', applyMode: 'as-swipe', contextMessages: 13 }
    },
    snapshot: async () => {
      if (swipeStarting) lifecycleEvents.push('swipe-snapshot-read');
      return activeSnapshot;
    },
    hostMessages: {
      activeAssistantMessageIdentity() {
        return { ...message };
      },
      async holdAssistantMessage() {
        lifecycleEvents.push('editorial-held');
        return { ok: true };
      },
      async revealAssistantMessage() {
        lifecycleEvents.push('editorial-reveal-complete');
        return { ok: true };
      },
      async appendAssistantMessageSwipe() {
        appendCount += 1;
        return { ok: true };
      },
      async findEnhancedSwipe() {
        return null;
      }
    },
    generationRouter: {
      async generate(roleId, request = {}, options = {}) {
        providerRoles.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              sceneStatus: 'same-scene',
              cardJobs: [{ role: 'sceneFrameCard', family: 'Scene Frame', priority: 100 }],
              reasonerDecision: { mode: 'skip', reason: 'overlap swipe setup', signals: [] },
              budgets: { targetBriefTokens: 500, maxCards: 6 },
              diagnostics: ['editorial-overlap-swipe-setup']
            }
          };
        }
        if (roleId === 'fusedCardBundle') {
          return {
            ok: true,
            data: {
              schema: 'recursion.cardBundle.v1',
              snapshotHash: request.snapshotHash,
              items: [{
                schema: 'recursion.card.v1',
                role: 'sceneFrameCard',
                family: 'Scene Frame',
                promptText: 'Keep the team seated while they assess the transport method.',
                evidenceRefs: ['message:29'],
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
              guidanceText: 'Keep the response in the diner booth.',
              sourceCardIds: request.sourceCardIds || [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['editorial-overlap-swipe-guidance']
            }
          };
        }
        if (roleId === 'editorialDiagnostician') {
          return {
            ok: true,
            data: {
              schema: 'recursion.editorialDiagnosis.v1',
              mode: 'recompose',
              sourceHash: request.sourceHash,
              snapshotHash: request.snapshotHash,
              decision: 'proceed',
              brief: {
                mode: 'recompose',
                diagnosis: [{ dimension: 'continuity', problem: 'Tighten the immediate reaction.', evidenceRefs: ['source:0'] }],
                preserve: [{ claim: 'The team remains seated.', evidenceRefs: ['message:29'] }],
                discard: [{ claim: 'Loose reaction wording.', evidenceRefs: ['source:0'] }],
                allowedChanges: ['Rewrite the immediate reaction.'],
                forbiddenChanges: ['Do not move anyone out of the booth.']
              }
            }
          };
        }
        if (roleId === 'editorialTransformer') {
          transformerStarted = true;
          transformerSignal = options.signal || null;
          lifecycleEvents.push('editorial-transformer-started');
          if (transformerSignal?.aborted) transformerRelease();
          else transformerSignal?.addEventListener?.('abort', () => transformerRelease(), { once: true });
          await transformerGate;
          return {
            ok: false,
            error: {
              code: transformerSignal?.aborted ? 'RECURSION_PROVIDER_ABORTED' : 'TEST_TRANSFORMER_RELEASED',
              message: transformerSignal?.aborted ? 'Provider generation was aborted.' : 'Test released uncanceled transformer.'
            }
          };
        }
        throw new Error(`unexpected editorial overlap role ${roleId}`);
      }
    }
  });

  const first = await runtime.prepareForGeneration({ userMessage: userText, hostGeneration: true });
  assertEqual(first.ok, true, 'Editorial overlap setup installs the initial Fused packet');
  const initialPacketId = installed.at(-1)?.packetId;
  const initialPipelineCalls = providerRoles.filter((roleId) => ['utilityArbiter', 'fusedCardBundle', 'guidanceComposer'].includes(roleId)).length;
  activeSnapshot = snapshotFromMessages([
    ...initialMessages,
    { mesid: 30, role: 'assistant', text: assistantText, visible: true, swipeId: 1, swipeCount: 2, activeSwipeTextHash: hashJson('') }
  ]);
  const enhancement = runtime.enhanceLatestAssistantMessage({ reason: 'assistant-message-landed' });
  await waitUntil(() => transformerStarted, 'Editorial overlap transformer did not start');
  swipeStarting = true;
  const second = await runtime.prepareForGeneration({ userMessage: null, hostGeneration: true, generationType: 'swipe' });
  const signalWasAborted = isAbortSignal(transformerSignal) && transformerSignal.aborted;
  transformerRelease();
  const enhancementResult = await enhancement;
  const revealIndex = lifecycleEvents.indexOf('editorial-reveal-complete');
  const swipeSnapshotIndex = lifecycleEvents.indexOf('swipe-snapshot-read');
  const finalPipelineCalls = providerRoles.filter((roleId) => ['utilityArbiter', 'fusedCardBundle', 'guidanceComposer'].includes(roleId)).length;

  assertEqual(signalWasAborted, true, 'native swipe aborts the active Editorial provider call');
  assertEqual(enhancementResult.skipped, true, 'aborted Editorial work settles as skipped');
  assertEqual(enhancementResult.reason, 'latest-assistant-swipe', 'aborted Editorial work records the swipe cancellation reason');
  assert(revealIndex >= 0 && revealIndex < swipeSnapshotIndex, 'Editorial reveal completes before the swipe snapshot is read');
  assertEqual(second.reused, true, 'overlapping Editorial swipe reuses the previous packet');
  assertEqual(second.reason, 'same-turn-swipe-retry', 'overlapping Editorial swipe reports packet reuse');
  assertEqual(finalPipelineCalls, initialPipelineCalls, 'overlapping Editorial swipe makes no new Arbiter, Fused, or Guidance calls');
  assertEqual(installed.at(-1)?.packetId, initialPacketId, 'overlapping Editorial swipe preserves packet identity');
  assertEqual(appendCount, 0, 'aborted Editorial work appends no enhancement swipe');
  assertEqual(runtime.view().activity.label, 'Recursion prompt reused for swipe retry.', 'new swipe progress remains authoritative after old Editorial cancellation');
}

{
  let providerCalls = 0;
  const baseSnapshot = {
    chatId: 'force-same-turn-chat',
    chatKey: 'force-same-turn-chat',
    sceneKey: 'force-same-turn-scene',
    sceneFingerprint: 'force-same-turn-scene-fp',
    turnFingerprint: 'force-same-turn-fp',
    latestMesId: 2,
    messages: [
      { mesid: 2, role: 'assistant', text: 'Same turn fresh-next base response.', visible: true }
    ]
  };
  const { runtime, installed, storage } = createRuntimeHarness({
    settings: { pipelineMode: 'standard', mode: 'auto', reasonerUse: 'off' },
    snapshot: () => baseSnapshot,
    generationRouter: {
      async generate(roleId, request = {}) {
        providerCalls += 1;
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              cardJobs: [{ role: 'sceneFrameCard', family: 'Scene Frame', priority: 100 }],
              budgets: { targetBriefTokens: 500, maxCards: 6 },
              reasonerDecision: { mode: 'skip', reason: 'force same-turn setup', signals: [] },
              diagnostics: ['force-same-turn-arbiter']
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
                promptText: `Force same-turn generated card ${providerCalls}.`,
                evidenceRefs: ['message:2'],
                tokenEstimate: 8
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
              guidanceText: `Force same-turn guidance ${providerCalls}.`,
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['force-same-turn-guidance']
            }
          };
        }
        throw new Error(`unexpected force same-turn role ${roleId}`);
      }
    }
  });
  const userMessage = 'Force next generation fresh for this same turn.';
  const first = await runtime.prepareForGeneration({ userMessage, hostGeneration: true });
  assertEqual(first.ok, true, 'fresh next same-turn setup installs');
  assertEqual(installed.length, 1, 'fresh next same-turn setup installs one packet');
  const callsAfterFirst = providerCalls;
  const firstPacketId = runtime.view().lastBrief?.packetId;
  const firstHandId = runtime.view().lastBrief?.handId;
  const queued = await runtime.requestFreshNextGeneration({ source: 'bar' });
  assertEqual(queued.ok, true, 'fresh next generation queues successfully');
  assertEqual(runtime.view().freshNextGeneration?.pending, true, 'fresh next generation is visible as pending');
  assertEqual(runtime.view().lastBrief?.status, 'ready', 'fresh next generation keeps Last Brief ready until send or swipe');
  assertEqual(runtime.view().lastBrief?.packetId, firstPacketId, 'fresh next generation keeps the previous packet visible while armed');
  assertEqual(runtime.view().lastBrief?.handId, firstHandId, 'fresh next generation keeps the previous hand visible while armed');
  const second = await runtime.prepareForGeneration({ userMessage, hostGeneration: true });
  assertEqual(second.ok, true, 'fresh next same-turn run succeeds');
  assertEqual(second.reused, undefined, 'fresh next same-turn run does not report packet reuse');
  assert(providerCalls > callsAfterFirst, 'fresh next same-turn run calls providers again');
  assertEqual(installed.length, 2, 'fresh next same-turn run installs a fresh packet');
  assertNotEqual(installed[0].packetId, installed[1].packetId, 'fresh next same-turn run changes packet identity');
  assertEqual(runtime.view().freshNextGeneration?.pending, false, 'fresh next token is consumed after host generation prepare');
  assertEqual(runtime.view().lastBrief?.status, 'ready', 'fresh next same-turn restores Last Brief ready state');
  assertEqual(runtime.view().lastBrief?.reason, 'fresh-next-generation-installed', 'fresh next same-turn marks forced install reason');
  const journal = await storage.loadRunJournal(baseSnapshot.chatKey);
  assert(journal.entries.some((entry) => entry.event === 'cache.invalidated' && entry.details?.reason === 'user-fresh-next-generation'), 'fresh next same-turn records cache invalidation journal');
}

{
  const hostStartCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { pipelineMode: 'standard', mode: 'auto', reasonerUse: 'off' },
    hostGeneration: {
      async start(details = {}) {
        hostStartCalls.push(details);
        return { ok: true, started: true };
      }
    }
  });
  assertEqual(runtimeHasOwnMethod(runtime, 'forceRegenerateNow'), false, 'runtime does not expose immediate forceRegenerateNow');
  assertEqual(typeof runtime.requestFreshNextGeneration, 'function', 'runtime exposes fresh-next-generation request');
  assertEqual(typeof runtime.clearFreshNextGeneration, 'function', 'runtime exposes fresh-next-generation clear');

  const queued = await runtime.requestFreshNextGeneration({ source: 'bar' });
  assertEqual(queued.ok, true, 'fresh next generation queues successfully');
  assertEqual(runtime.view().freshNextGeneration?.pending, true, 'fresh next generation is visible as pending');
  assertEqual(runtime.view().lastBrief?.status, 'empty', 'fresh next generation does not synthesize Last Brief state before a packet exists');
  assertDeepEqual(hostStartCalls, [], 'queuing fresh next generation does not start host generation');
}

{
  const { runtime } = createRuntimeHarness({
    settings: { pipelineMode: 'standard', mode: 'auto', reasonerUse: 'off' }
  });

  await runtime.requestFreshNextGeneration({ source: 'bar' });
  assertEqual(runtime.view().freshNextGeneration?.pending, true, 'fresh next generation starts pending');
  const cleared = await runtime.clearFreshNextGeneration({ source: 'bar' });
  assertEqual(cleared.ok, true, 'fresh next generation clear succeeds');
  assertEqual(runtime.view().freshNextGeneration?.pending, false, 'fresh next generation clear removes pending token');
  assertEqual(runtime.view().lastBrief?.status, 'empty', 'fresh next generation cancel leaves Last Brief state alone');
}

{
  let providerCalls = 0;
  const userMessage = 'Fresh next generation for the latest assistant swipe.';
  const chatId = 'force-latest-assistant-chat';
  const initialMessages = [
    { mesid: 20, role: 'user', text: userMessage, textHash: hashJson(userMessage), visible: true }
  ];
  const snapshotFromMessages = (messages) => ({
    chatId,
    chatKey: chatId,
    sceneKey: 'force-latest-assistant-scene',
    sceneFingerprint: 'force-latest-assistant-scene-fp',
    latestMesId: messages.at(-1)?.mesid || 0,
    messages
  });
  let activeSnapshot = snapshotFromMessages(initialMessages);
  const { runtime, installed } = createRuntimeHarness({
    settings: { pipelineMode: 'standard', mode: 'auto', reasonerUse: 'off' },
    snapshot: () => activeSnapshot,
    generationRouter: {
      async generate(roleId, request = {}) {
        providerCalls += 1;
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              cardJobs: [{ role: 'sceneFrameCard', family: 'Scene Frame', priority: 100 }],
              budgets: { targetBriefTokens: 500, maxCards: 6 },
              reasonerDecision: { mode: 'skip', reason: 'fresh latest assistant setup', signals: [] },
              diagnostics: ['fresh-latest-assistant-arbiter']
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
                promptText: 'Fresh latest assistant generated card.',
                evidenceRefs: ['message:20'],
                tokenEstimate: 8
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
              guidanceText: 'Fresh latest assistant guidance.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['fresh-latest-assistant-guidance']
            }
          };
        }
        throw new Error(`unexpected fresh latest assistant role ${roleId}`);
      }
    }
  });
  const first = await runtime.prepareForGeneration({ userMessage, hostGeneration: true });
  assertEqual(first.ok, true, 'fresh latest assistant setup installs');
  const callsAfterFirst = providerCalls;
  activeSnapshot = snapshotFromMessages([
    ...initialMessages,
    {
      mesid: 21,
      role: 'assistant',
      text: 'Latest assistant response about to be swiped.',
      textHash: hashJson('Latest assistant response about to be swiped.'),
      visible: true,
      swipeId: 1,
      swipeCount: 2,
      activeSwipeTextHash: hashJson('Forced alternate assistant response.')
    }
  ]);
  await runtime.handleLatestAssistantSwipeRetry({ eventName: 'message_swiped', messageId: 21 });
  assertEqual(runtime.view().lastBrief?.status, 'ready', 'latest-assistant swipe marker preserves the visible Last Brief until generation starts');
  assert(runtime.view().lastBriefHand?.cards.length > 0, 'latest-assistant swipe marker preserves retained Last Brief cards');
  assertEqual(runtime.view().lastBriefPacket?.packetId, installed[0].packetId, 'latest-assistant swipe marker preserves the retained Last Brief packet');
  const queued = await runtime.requestFreshNextGeneration({ source: 'bar' });
  assertEqual(queued.ok, true, 'fresh latest assistant queues after swipe marker');
  assertEqual(runtime.view().lastBrief?.status, 'ready', 'fresh latest assistant arming keeps Last Brief ready before generation');
  const second = await runtime.prepareForGeneration({ userMessage: null, hostGeneration: true });
  assertEqual(second.ok, true, 'fresh latest assistant run succeeds');
  assertEqual(second.reused, undefined, 'fresh latest assistant does not reuse previous packet');
  assert(providerCalls > callsAfterFirst, 'fresh latest assistant run calls providers again');
  assertEqual(installed.length, 2, 'fresh latest assistant installs a second packet');
  assertNotEqual(installed[0].packetId, installed[1].packetId, 'fresh latest assistant changes packet identity');
  assertEqual(runtime.view().lastSnapshot.latestMesId, 21, 'fresh latest assistant uses current post-swipe snapshot');
}

{
  const { snapshot, baseSourceRevisionHash } = rapidWarmSnapshotFixture();
  const storage = createStorageRepository({ storage: createMemoryStorageAdapter() });
  await storage.saveSceneCache(snapshot.chatKey, snapshot.sceneKey, rapidWarmCacheFixture({ cardId: 'warm-card-1', baseSourceRevisionHash }));
  const roleCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { pipelineMode: 'rapid', mode: 'auto', reasonerUse: 'off' },
    storage,
    snapshot: () => snapshot,
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'rapidTurnDelta') {
          return {
            ok: true,
            data: {
              schema: 'recursion.rapidTurnDelta.v2',
              snapshotHash: request.snapshotHash,
              guidanceText: 'Rapid delta should be bypassed during fresh next generation.',
              mandatoryGapIds: [],
              sourceCardIds: ['warm-card-1'],
              diagnostics: ['fresh-rapid-delta']
            }
          };
        }
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              cardJobs: [{ role: 'sceneFrameCard', family: 'Scene Frame', priority: 100 }],
              budgets: { targetBriefTokens: 500, maxCards: 6 },
              reasonerDecision: { mode: 'skip', reason: 'fresh rapid standard path', signals: [] },
              diagnostics: ['fresh-rapid-standard-arbiter']
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
                promptText: 'Fresh rapid generated card.',
                evidenceRefs: ['message:2'],
                tokenEstimate: 8
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
              guidanceText: 'Fresh rapid standard guidance.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['fresh-rapid-standard-guidance']
            }
          };
        }
        throw new Error(`unexpected fresh rapid role ${roleId}`);
      }
    }
  });
  await runtime.requestFreshNextGeneration({ source: 'bar' });
  const result = await runtime.prepareForGeneration({ userMessage: 'Try the hatch fresh.', hostGeneration: true });
  assertEqual(result.ok, true, 'fresh rapid run succeeds');
  assert(!roleCalls.includes('rapidTurnDelta'), 'fresh rapid run bypasses Rapid foreground delta');
  assert(roleCalls.includes('utilityArbiter'), 'fresh rapid run uses Standard utility Arbiter');
  assert(JSON.stringify(result.packet).includes('fresh-next-generation:rapid-bypassed'), 'fresh rapid packet records Rapid bypass diagnostic');
}

{
  const snapshot = {
    chatId: 'force-cache-exclusion-chat',
    chatKey: 'force-cache-exclusion-chat',
    sceneKey: 'force-cache-exclusion-scene',
    sceneFingerprint: 'force-cache-exclusion-scene-fp',
    turnFingerprint: 'force-cache-exclusion-turn-fp',
    latestMesId: 2,
    messages: [{ mesid: 2, role: 'user', text: 'Fresh cached hand.', visible: true }]
  };
  const storage = createStorageRepository({ storage: createMemoryStorageAdapter() });
  await storage.saveSceneCache(snapshot.chatKey, snapshot.sceneKey, {
    cacheState: 'active',
    versions: cacheContractVersions({ mode: 'auto', reasonerUse: 'off' }),
    cards: [{
      id: 'fresh-cache-card',
      family: 'Scene Frame',
      promptText: 'FRESH CACHE TEXT MUST NOT INSTALL.',
      evidenceRefs: ['message:2'],
      source: {
        chatId: snapshot.chatId,
        firstMesId: 2,
        lastMesId: 2,
        sourceRevisionHash: snapshot.sourceRevisionHash || sourceWindowHash(snapshot.messages, 2, 2)
      },
      freshness: { sourceRevisionHash: snapshot.sourceRevisionHash || sourceWindowHash(snapshot.messages, 2, 2) }
    }],
    latestHand: {
      handId: 'force-cache-hand',
      cardIds: ['fresh-cache-card'],
      cards: [{ id: 'fresh-cache-card', family: 'Scene Frame' }]
    }
  });
  let arbiterPrompt = '';
  const { runtime, installed } = createRuntimeHarness({
    settings: { pipelineMode: 'standard', mode: 'auto', reasonerUse: 'off' },
    storage,
    snapshot: () => snapshot,
    generationRouter: {
      async generate(roleId, request = {}) {
        if (roleId === 'utilityArbiter') {
          arbiterPrompt = request.prompt;
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'reuse-cache',
              cardJobs: [],
              budgets: { targetBriefTokens: 500, maxCards: 6 },
              reasonerDecision: { mode: 'skip', reason: 'fresh next should override reuse-cache', signals: [] },
              diagnostics: ['fresh-cache-reuse-requested']
            }
          };
        }
        throw new Error(`unexpected fresh cache exclusion role ${roleId}`);
      }
    }
  });
  await runtime.requestFreshNextGeneration({ source: 'bar' });
  const result = await runtime.prepareForGeneration({ userMessage: 'Fresh cached hand.', hostGeneration: true });
  assertEqual(result.ok, true, 'fresh cache exclusion run succeeds');
  assertEqual(result.skipped, undefined, 'fresh cache exclusion does not skip as cache-unavailable');
  assertEqual(installed.length, 1, 'fresh cache exclusion installs a prompt');
  assert(!JSON.stringify(installed[0]).includes('FRESH CACHE TEXT MUST NOT INSTALL'), 'fresh cache exclusion does not install cached prompt text');
  const sceneCacheView = parsePromptJsonSection(arbiterPrompt, 'Scene cache');
  assertEqual(sceneCacheView.cacheState, 'stale', 'fresh cache exclusion marks cache stale for Arbiter evidence');
  assertEqual(sceneCacheView.invalidation?.reason, 'user-fresh-next-generation', 'fresh cache exclusion tells Arbiter why cache is stale');
}

{
  let utilityCallCount = 0;
  let releaseSecondArbiter;
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request = {}) {
        if (roleId === 'utilityArbiter') {
          utilityCallCount += 1;
          if (utilityCallCount === 2) {
            await new Promise((resolve) => {
              releaseSecondArbiter = resolve;
            });
          }
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              cardJobs: [{ role: 'sceneFrameCard', family: 'Scene Frame', reason: 'Last Brief lifecycle test.' }],
              budgets: { targetBriefTokens: 500, maxCards: 6 },
              reasonerDecision: { mode: 'skip', reason: 'last brief lifecycle test', signals: [] },
              diagnostics: ['last-brief-lifecycle']
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
                promptText: 'Last Brief lifecycle card guidance.',
                evidenceRefs: ['message:2'],
                tokenEstimate: 8
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
              guidanceText: 'Last Brief lifecycle guidance.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['last-brief-lifecycle-guidance']
            }
          };
        }
        throw new Error(`unexpected Last Brief lifecycle role ${roleId}`);
      }
    }
  });
  const first = await runtime.prepareForGeneration({ userMessage: 'Build visible Last Brief.' });
  assertEqual(first.ok, true, 'Last Brief lifecycle setup installs first packet');
  const firstView = runtime.view();
  assertEqual(firstView.lastBrief?.status, 'ready', 'Last Brief is ready after first packet install');
  assert(firstView.lastBrief?.packetId, 'Last Brief ready state includes packet id');
  assertEqual(firstView.lastBrief?.cardCount, firstView.lastHand.cards.length, 'Last Brief ready state records card count');

  const sourceChange = await runtime.handleSourceChanged({ eventName: 'message_updated', messageId: 4 });
  assertEqual(sourceChange.ok, true, 'source-change cleanup succeeds before the next user generation');
  const retainedReview = runtime.view();
  assertEqual(retainedReview.lastPacket, null, 'source-change cleanup invalidates the reusable packet');
  assertEqual(retainedReview.lastHand.cards.length, 0, 'source-change cleanup invalidates the reusable hand');
  assertEqual(retainedReview.lastBrief?.status, 'ready', 'source-change cleanup keeps Last Brief reviewable while idle');
  assertEqual(retainedReview.lastBriefPacket?.packetId, firstView.lastBrief.packetId, 'source-change cleanup retains the reviewed packet snapshot');
  assertEqual(retainedReview.lastBriefHand?.cards.length, firstView.lastHand.cards.length, 'source-change cleanup retains the reviewed cards');

  const second = runtime.prepareForGeneration({ userMessage: 'Start next turn and clear visible Last Brief.' });
  await waitUntil(() => typeof releaseSecondArbiter === 'function', 'second Last Brief lifecycle run did not enter Arbiter');
  const during = runtime.view();
  assertEqual(during.lastBrief?.status, 'clearing', 'Last Brief enters clearing state as soon as a new send starts');
  assertEqual(during.lastBrief?.reason, 'generation-started', 'new send records generation-started clear reason');
  assertEqual(during.lastBrief?.previousPacketId, firstView.lastBrief.packetId, 'clearing state points at the packet being cleared');
  assertEqual(during.lastBriefHand?.cards.length, 0, 'new send consumes the retained Last Brief cards');
  assertEqual(during.lastBriefPacket, null, 'new send consumes the retained Last Brief packet');
  releaseSecondArbiter();
  const secondResult = await second;
  assertEqual(secondResult.ok, true, 'second Last Brief lifecycle run installs');
  assertEqual(runtime.view().lastBrief?.status, 'ready', 'Last Brief becomes ready again after next packet install');
}

{
  const { runtime, installed, cleared } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: null
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Utility router missing.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'missing Utility router remains fail-soft');
  assertEqual(result.skipped, true, 'missing Utility router skips prompt injection');
  assertEqual(result.reason, 'utility-unavailable', 'missing Utility router returns Utility unavailable reason');
  assertEqual(installed.length, 0, 'missing Utility router does not install prompt');
  assertEqual(cleared.length, 1, 'missing Utility router clears stale prompt lanes');
  assert(view.lastPlan.diagnostics.includes('utility-unavailable'), 'missing Utility router diagnostic recorded');
}

{
  const { runtime, installed, cleared } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        assertEqual(roleId, 'utilityArbiter', 'Utility unavailable test only asks Arbiter');
        return { ok: false, error: { code: 'timeout', message: 'Utility timeout with Bearer utility-token and sk-utility-runtime' } };
      },
      async batch() {
        throw new Error('utility unavailable should not request card batch');
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Utility is unavailable.' });
  const view = runtime.view();
  const serialized = JSON.stringify({ result, view });
  assertEqual(result.ok, true, 'Utility unavailable remains fail-soft');
  assertEqual(result.skipped, true, 'Utility unavailable skips prompt injection without cache');
  assertEqual(result.reason, 'utility-unavailable', 'Utility unavailable returns explicit reason');
  assertEqual(installed.length, 0, 'Utility unavailable without cache does not install prompt');
  assertEqual(cleared.length, 1, 'Utility unavailable clears any stale Recursion prompt');
  assert(view.lastPlan.diagnostics.includes('utility-unavailable'), 'Utility unavailable diagnostic recorded');
  assert(!view.lastPlan.diagnostics.includes('local-fallback-plan'), 'Utility unavailable does not use local fallback plan');
  assertEqual(view.activity.label, 'Utility unavailable. Recursion skipped.', 'Utility unavailable shows clear fallback label');
  assert(!serialized.includes('Bearer utility-token'), 'Utility unavailable reason redacts bearer token');
  assert(!serialized.includes('sk-utility-runtime'), 'Utility unavailable reason redacts sk token');
}

{
  const cachedMessages = [
    { mesid: 2, role: 'user', text: 'Use cache while Utility is down.', visible: true }
  ];
  const cachedSourceHash = sourceWindowHash(cachedMessages, 2, 2);
  const storage = {
    async loadSceneCache() {
      return {
        versions: cacheContractVersions({ mode: 'auto', reasonerUse: 'off' }),
        cards: [{
          id: 'utility-down-cache-card',
          family: 'Scene Frame',
          promptText: 'Use the safe cached scene frame while Utility is unavailable.',
          summary: 'Safe cached scene frame',
          evidenceRefs: ['message:2'],
          emphasis: 'normal',
          source: {
            chatId: 'utility-down-chat',
            firstMesId: 2,
            lastMesId: 2,
            fingerprint: cachedSourceHash,
            snapshotHash: cachedSourceHash
          },
          freshness: { sourceFingerprint: cachedSourceHash }
        }]
      };
    },
    async saveSceneCache() {
      return {};
    },
    async appendJournal() {
      return {};
    }
  };
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    snapshot: {
      chatId: 'utility-down-chat',
      chatKey: 'utility-down-chat',
      sceneKey: 'utility-down-scene',
      sceneFingerprint: 'utility-down-scene-fp',
      turnFingerprint: 'utility-down-turn-fp',
      latestMesId: 2,
      messages: cachedMessages
    },
    generationRouter: {
      async generate(roleId, request) {
        assertEqual(roleId, 'utilityArbiter', 'Utility unavailable cache test only asks Arbiter');
        throw new Error('Utility transport unavailable');
      },
      async batch() {
        throw new Error('Utility unavailable cache test should not request card batch');
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Use cache while Utility is down.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'Utility unavailable can reuse valid cache');
  assertEqual(result.skipped, undefined, 'Utility unavailable with valid cache does not skip');
  assertEqual(installed.length, 1, 'Utility unavailable with valid cache installs prompt');
  assert(view.lastPlan.diagnostics.includes('utility-unavailable'), 'Utility unavailable cache diagnostic recorded');
  assertDeepEqual(view.lastHand.cards.map((card) => card.id), ['utility-down-cache-card'], 'Utility unavailable uses cached hand only');
  assert(
    view.activityHistory.some((event) => event.phase === 'cardProgress'
      && event.detail?.source === 'cache'
      && event.detail?.state === 'cached'),
    'Utility unavailable cache path emits cached card progress'
  );
}

{
  const adapter = createMemoryStorageAdapter();
  const baseStorage = createStorageRepository({ storage: adapter });
  let saveCalls = 0;
  let finalHashSaveStarted = false;
  let releaseFinalHashSave;
  const storage = {
    ...baseStorage,
    async saveSceneCache(chatKey, sceneKey, value) {
      saveCalls += 1;
      if (saveCalls === 2) {
        finalHashSaveStarted = true;
        await new Promise((resolve) => {
          releaseFinalHashSave = resolve;
        });
      }
      return baseStorage.saveSceneCache(chatKey, sceneKey, value);
    }
  };
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    generationRouter: localFallbackCardRouter(['final-hash-save-test'])
  });
  const pending = runtime.prepareForGeneration({ userMessage: 'Install before final cache hash save.' });
  await waitUntil(() => finalHashSaveStarted, 'final prompt-packet hash cache save did not start');
  assertEqual(installed.length, 1, 'prompt installs before final prompt-packet-hash cache save can block');
  releaseFinalHashSave();
  const result = await pending;
  assertEqual(result.ok, true, 'run completes after final cache hash save');
}

{
  const adapter = createMemoryStorageAdapter();
  const baseStorage = createStorageRepository({ storage: adapter });
  let saveCalls = 0;
  let finalHashSaveStarted = false;
  let releaseFinalHashSave;
  const storage = {
    ...baseStorage,
    async saveSceneCache(chatKey, sceneKey, value) {
      saveCalls += 1;
      if (saveCalls === 2) {
        finalHashSaveStarted = true;
        await new Promise((resolve) => {
          releaseFinalHashSave = resolve;
        });
      }
      return baseStorage.saveSceneCache(chatKey, sceneKey, value);
    }
  };
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    generationRouter: localFallbackCardRouter(['journal-final-hash-save-test'])
  });
  const pending = runtime.prepareForGeneration({ userMessage: 'Journal install before superseded final cache save.' });
  await waitUntil(() => finalHashSaveStarted, 'journal regression final cache save did not start');
  assertEqual(installed.length, 1, 'journal regression prompt is installed before final cache save');
  const providerUpdate = runtime.updateProvider('utility', { source: 'host-current-model' });
  await Promise.resolve();
  releaseFinalHashSave();
  await Promise.allSettled([pending, providerUpdate]);
  const journal = await baseStorage.loadRunJournal('chat-1');
  assert(journal.entries.some((entry) => entry.event === 'hand.selected'), 'installed prompt hand journal survives superseded final save');
  assert(journal.entries.some((entry) => entry.event === 'prompt.installed'), 'installed prompt install journal survives superseded final save');
}

{
  const { runtime, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: localFallbackCardRouter(['cache-invalidation-setup'])
  });
  const run = await runtime.prepareForGeneration({ userMessage: 'The lamp breaks.' });
  assertEqual(run.ok, true, 'cache invalidation setup run installs');
  const snapshot = runtime.view().lastSnapshot;

  const providerUpdate = await runtime.updateProvider('utility', {
    source: 'openai-compatible',
    apiKey: 'sk-live-runtime',
    openAICompatible: {
      baseUrl: 'https://provider-change.test/v1',
      model: 'provider-change-model'
    }
  });
  assertEqual(providerUpdate.ok, true, 'provider update still succeeds after cache invalidation');
  let cache = await storage.loadSceneCache(snapshot.chatKey, snapshot.sceneKey);
  assertEqual(cache.cacheState, 'stale', 'provider update marks active scene cache stale');
  assertEqual(cache.invalidation.reason, 'provider-changed', 'provider update records invalidation reason');
  assertDeepEqual(cache.invalidation.details.changedKeys, ['source', 'apiKey', 'openAICompatible'], 'provider invalidation records changed keys');
  assert(!JSON.stringify(cache.invalidation).includes('provider-change-model'), 'provider invalidation does not persist raw model patch');
  assert(!JSON.stringify(cache.invalidation).includes('provider-change.test'), 'provider invalidation does not persist raw endpoint patch');
  assertNoSecretText(cache.invalidation, 'provider cache invalidation');
  let journal = await storage.loadRunJournal(snapshot.chatKey);
  assert(journal.entries.some((entry) => entry.event === 'cache.invalidated' && entry.details?.reason === 'provider-changed'), 'provider update records cache invalidation journal');
  assert(!JSON.stringify(journal).includes('provider-change-model'), 'provider invalidation journal does not persist raw model patch');
  assert(!JSON.stringify(journal).includes('provider-change.test'), 'provider invalidation journal does not persist raw endpoint patch');
  assertNoSecretText(journal, 'provider cache invalidation journal');
  assert(journal.entries.some((entry) => entry.event === 'prompt.cleared' && entry.details?.reason === 'provider-changed'), 'provider update records prompt clear journal');
  assertNoSecretText(journal.entries.find((entry) => entry.event === 'prompt.cleared'), 'provider prompt clear journal');

  const settingsUpdate = await runtime.updateSettings({ strength: 'strong' });
  assertEqual(settingsUpdate.ok, true, 'settings update still succeeds after cache invalidation');
  cache = await storage.loadSceneCache(snapshot.chatKey, snapshot.sceneKey);
  assertEqual(cache.cacheState, 'stale', 'settings update keeps scene cache stale');
  assertEqual(cache.invalidation.reason, 'settings-changed', 'settings update records invalidation reason');
  assertNoSecretText(cache.invalidation, 'settings cache invalidation');
  journal = await storage.loadRunJournal(snapshot.chatKey);
  assert(journal.entries.some((entry) => entry.event === 'cache.invalidated' && entry.details?.reason === 'settings-changed'), 'settings update records cache invalidation journal');
}

{
  let arbiterPrompts = [];
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request = {}) {
        assertEqual(roleId, 'utilityArbiter', 'stale cache arbiter metadata test only calls arbiter');
        arbiterPrompts.push(request.prompt);
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            budgets: { targetBriefTokens: 500, maxCards: 4 }
          }
        };
      }
    }
  });
  const first = await runtime.prepareForGeneration({ userMessage: 'Build cache before invalidation.' });
  assertEqual(first.ok, true, 'stale cache metadata setup run installs');
  const providerUpdate = await runtime.updateProvider('utility', { source: 'host-current-model' });
  assertEqual(providerUpdate.ok, true, 'provider update invalidates cache before next arbiter pass');
  arbiterPrompts = [];
  const second = await runtime.prepareForGeneration({ userMessage: 'Arbiter should see stale cache.' });
  assertEqual(second.ok, true, 'stale cache metadata followup run installs');
  assert(arbiterPrompts[0].includes('"cacheState":"stale"'), 'arbiter prompt includes stale cache state');
  assert(arbiterPrompts[0].includes('"reason":"provider-changed"'), 'arbiter prompt includes invalidation reason');
}

{
  const adapter = createMemoryStorageAdapter();
  const baseStorage = createStorageRepository({ storage: adapter });
  let releaseInvalidation;
  let invalidationStarted = false;
  let invalidationCompleted = false;
  const storage = {
    ...baseStorage,
    async invalidateSceneCache(chatKey, sceneKey, options) {
      invalidationStarted = true;
      await new Promise((resolve) => {
        releaseInvalidation = resolve;
      });
      const result = await baseStorage.invalidateSceneCache(chatKey, sceneKey, options);
      invalidationCompleted = true;
      return result;
    }
  };
  const arbiterPrompts = [];
  let arbiterCalls = 0;
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    generationRouter: {
      async generate(roleId, request = {}) {
        assertEqual(roleId, 'utilityArbiter', 'concurrent invalidation wait test only calls arbiter');
        arbiterCalls += 1;
        if (arbiterCalls > 1) {
          assertEqual(invalidationCompleted, true, 'prepare waits for cache invalidation before asking Arbiter');
        }
        arbiterPrompts.push(request.prompt);
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            budgets: { targetBriefTokens: 500, maxCards: 4 }
          }
        };
      }
    }
  });
  const first = await runtime.prepareForGeneration({ userMessage: 'Build cache before delayed invalidation.' });
  assertEqual(first.ok, true, 'delayed invalidation setup run installs');
  const providerUpdate = runtime.updateProvider('utility', { source: 'host-current-model' });
  await waitUntil(() => invalidationStarted, 'provider update did not start invalidation');
  const second = runtime.prepareForGeneration({ userMessage: 'Wait for invalidation before reading cache.' });
  releaseInvalidation();
  const updateResult = await providerUpdate;
  assertEqual(updateResult.ok, true, 'provider update succeeds after delayed invalidation');
  const secondResult = await second;
  assertEqual(secondResult.ok, true, 'prepare after delayed invalidation succeeds');
  assert(arbiterPrompts[1].includes('"cacheState":"stale"'), 'concurrent prepare Arbiter prompt includes stale cache state');
  assert(arbiterPrompts[1].includes('"reason":"provider-changed"'), 'concurrent prepare Arbiter prompt includes invalidation reason');
}

{
  const adapter = createMemoryStorageAdapter();
  const baseStorage = createStorageRepository({ storage: adapter });
  let releaseSave;
  let saveStarted = false;
  const storage = {
    ...baseStorage,
    async saveSceneCache(chatKey, sceneKey, value) {
      saveStarted = true;
      await new Promise((resolve) => {
        releaseSave = resolve;
      });
      return baseStorage.saveSceneCache(chatKey, sceneKey, value);
    }
  };
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage
  });
  const run = runtime.prepareForGeneration({ userMessage: 'Save is still in flight.' });
  await waitUntil(() => saveStarted, 'in-flight save did not start before provider update');
  const providerUpdatePromise = runtime.updateProvider('utility', { source: 'host-current-model' });
  releaseSave();
  const providerUpdate = await providerUpdatePromise;
  assertEqual(providerUpdate.ok, true, 'provider update succeeds while save is in flight');
  const runResult = await run;
  assertEqual(runResult.superseded, true, 'in-flight save run is superseded by provider update');
  const snapshot = runtime.view().lastSnapshot;
  const cache = await baseStorage.loadSceneCache(snapshot.chatKey, snapshot.sceneKey);
  assertEqual(cache.cacheState, 'stale', 'provider update leaves in-flight saved cache stale');
  assertEqual(cache.invalidation.reason, 'provider-changed', 'in-flight saved cache records provider invalidation');
}

{
  const adapter = createMemoryStorageAdapter();
  const baseStorage = createStorageRepository({ storage: adapter });
  let saveCalls = 0;
  let delayedSaveStarted = false;
  let releaseDelayedSave;
  let invalidationCompleted = false;
  const storage = {
    ...baseStorage,
    async saveSceneCache(chatKey, sceneKey, value) {
      saveCalls += 1;
      if (saveCalls === 3) {
        delayedSaveStarted = true;
        await new Promise((resolve) => {
          releaseDelayedSave = resolve;
        });
      }
      return baseStorage.saveSceneCache(chatKey, sceneKey, value);
    },
    async invalidateSceneCache(chatKey, sceneKey, options) {
      const result = await baseStorage.invalidateSceneCache(chatKey, sceneKey, options);
      invalidationCompleted = true;
      return result;
    }
  };
  let arbiterCalls = 0;
  const arbiterPrompts = [];
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    generationRouter: {
      async generate(roleId, request = {}) {
        assertEqual(roleId, 'utilityArbiter', 'storage-tail mutation wait test only calls arbiter');
        arbiterCalls += 1;
        if (arbiterCalls === 3) {
          assertEqual(invalidationCompleted, true, 'prepare waiting on storage tail also waits for provider invalidation added later');
        }
        arbiterPrompts.push(request.prompt);
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            budgets: { targetBriefTokens: 500, maxCards: 4 }
          }
        };
      }
    }
  });
  const first = await runtime.prepareForGeneration({ userMessage: 'Save first cache before storage wait.' });
  assertEqual(first.ok, true, 'storage-tail wait setup run installs');
  const delayedRun = runtime.prepareForGeneration({ userMessage: 'Delay second save.' });
  await waitUntil(() => delayedSaveStarted, 'second save did not enter delayed storage write');
  const waitingRun = runtime.prepareForGeneration({ userMessage: 'Wait through storage and provider mutation.' });
  const providerUpdate = runtime.updateProvider('utility', { source: 'host-current-model' });
  releaseDelayedSave();
  const updateResult = await providerUpdate;
  assertEqual(updateResult.ok, true, 'provider update succeeds after delayed storage save');
  const delayedResult = await delayedRun;
  assertEqual(delayedResult.superseded, true, 'delayed run is superseded by provider update');
  const waitingResult = await waitingRun;
  assertEqual(waitingResult.ok, true, 'waiting run succeeds after provider invalidation');
  assert(arbiterPrompts[2].includes('"cacheState":"stale"'), 'storage-tail waiting Arbiter prompt includes stale cache state');
  assert(arbiterPrompts[2].includes('"reason":"provider-changed"'), 'storage-tail waiting Arbiter prompt includes invalidation reason');
}

{
  let sceneId = 'saved-scene';
  let releaseSecondArbiter;
  let secondArbiterStarted = false;
  let arbiterCalls = 0;
  const { runtime, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => ({
      chatId: 'cache-target-chat',
      chatKey: 'cache-target-chat',
      sceneKey: sceneId,
      sceneFingerprint: `${sceneId}-fp`,
      turnFingerprint: `${sceneId}-turn-fp`,
      latestMesId: 2,
      messages: [
        { mesid: 2, role: 'user', text: `Message in ${sceneId}.`, visible: true }
      ]
    }),
    generationRouter: {
      async generate(roleId, request) {
        assertEqual(roleId, 'utilityArbiter', 'last saved cache invalidation test only calls arbiter');
        arbiterCalls += 1;
        if (arbiterCalls === 2) {
          secondArbiterStarted = true;
          await new Promise((resolve) => {
            releaseSecondArbiter = resolve;
          });
        }
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            budgets: { targetBriefTokens: 500, maxCards: 4 },
            diagnostics: [`arbiter-${arbiterCalls}`]
          }
        };
      }
    }
  });
  const first = await runtime.prepareForGeneration({ userMessage: 'Save first cache.' });
  assertEqual(first.ok, true, 'last saved cache setup run installs');
  const savedSnapshot = runtime.view().lastSnapshot;
  sceneId = 'unsaved-scene';
  const second = runtime.prepareForGeneration({ userMessage: 'Start unsaved second cache.' });
  await waitUntil(() => secondArbiterStarted, 'second arbiter did not start before provider update');
  const providerUpdate = await runtime.updateProvider('utility', { source: 'host-current-model' });
  assertEqual(providerUpdate.ok, true, 'provider update succeeds while newer run is superseded');
  releaseSecondArbiter();
  const secondResult = await second;
  assertEqual(secondResult.superseded, true, 'second run is superseded before saving cache');
  const savedCache = await storage.loadSceneCache(savedSnapshot.chatKey, savedSnapshot.sceneKey);
  assertEqual(savedCache.cacheState, 'stale', 'provider update invalidates last successfully saved cache');
  const unsavedCache = await storage.loadSceneCache('cache-target-chat', 'unsaved-scene');
  assertEqual(unsavedCache, null, 'provider update does not create or target unsaved cache');
}

{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: {
      chatId: 'secret-chat Bearer id-token',
      chatKey: 'secret-chat',
      sceneKey: 'scene sk-live-scene',
      sceneFingerprint: 'scene-fp Bearer scene-token',
      turnFingerprint: 'turn-fp sk-live-turn private-secret',
      latestMesId: 1,
      messages: [{ mesid: 1, role: 'user', text: 'Identifier metadata should be safe.', visible: true }]
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Secret identifiers.' });
  assertEqual(result.ok, true, 'secret identifier run installs');
  assertNoSecretText({ packet: result.packet, viewPacket: runtime.view().lastPacket, view: runtime.view() }, 'packet metadata');
}

{
  const directProviderCards = cardsFromProviderResult({
    ok: true,
    roleId: 'openThreadsCard',
    data: {
      schema: 'recursion.card.v1',
      role: 'openThreadsCard',
      family: 'Open Threads',
      snapshotHash: 'runtime-direct-snapshot-hash',
      items: [{
        sceneId: 'provider-direct-scene',
        chatId: 'provider-direct-chat',
        source: {
          chatId: 'provider-direct-source-chat',
          firstMesId: 100,
          lastMesId: 200
        },
        freshness: { sourceFingerprint: 'hallucinated-direct-freshness-hash' },
        promptText: 'Direct provider card should keep runtime-owned provenance.',
        evidenceRefs: ['message:2']
      }]
    }
  }, {
    sceneId: 'scene-1',
    chatId: 'chat-1',
    snapshotHash: 'runtime-direct-snapshot-hash',
    firstMesId: 1,
    lastMesId: 2,
    expectedRole: 'openThreadsCard',
    expectedFamily: 'Open Threads'
  });
  assertEqual(directProviderCards.length, 1, 'direct provider card normalizes');
  assertEqual(directProviderCards[0].sceneId, 'scene-1', 'direct provider card scene uses runtime context');
  assertEqual(directProviderCards[0].source.chatId, 'chat-1', 'direct provider card chat uses runtime context');
  assertEqual(directProviderCards[0].source.firstMesId, 1, 'direct provider card first message uses runtime context');
  assertEqual(directProviderCards[0].source.lastMesId, 2, 'direct provider card last message uses runtime context');
  assertEqual(directProviderCards[0].source.snapshotHash, 'runtime-direct-snapshot-hash', 'direct provider card source uses runtime hash');
  assertEqual(directProviderCards[0].freshness.sourceFingerprint, 'runtime-direct-snapshot-hash', 'direct provider card freshness uses runtime hash');

  const { runtime, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: {
      chatId: 'secret-chat',
      chatKey: 'secret-chat',
      sceneKey: 'secret-scene',
      sceneFingerprint: 'secret-scene-fp',
      turnFingerprint: 'secret-turn-fp',
      latestMesId: 4,
      messages: [{ mesid: 4, role: 'user', text: 'Bearer live-token and sk-live-runtime should not persist.', visible: true }]
    },
    hostPrompt: {
      async install() {
        throw new Error('install failed with Bearer live-token and sk-live-runtime');
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'secret test' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'secret install failure remains fail-soft');
  assertEqual(result.install.ok, false, 'secret install failure preserves non-ok install outcome');
  const cache = await storage.loadSceneCache(view.lastSnapshot.chatKey, view.lastSnapshot.sceneKey);
  const journal = await storage.loadRunJournal(view.lastSnapshot.chatKey);
  const serialized = JSON.stringify({ cache, journal });
  assert(!serialized.includes('Bearer live-token'), 'runtime cache and journal redact bearer token');
  assert(!serialized.includes('sk-live-runtime'), 'runtime cache and journal redact sk token');
  assertNoSecretText({ result, view }, 'install failure result and view');
}

{
  const { runtime, calls, installed, storage } = createRuntimeHarness({
    settings: { mode: 'manual', reasonerUse: 'off' }
  });
  const result = await runtime.prepareForGeneration({
    userMessage: 'Manual with Bearer live-token, sk-live-runtime, and private-secret.'
  });
  const view = runtime.view();
  assertEqual(result.ok, true, 'manual mode returns ok');
  assertEqual(result.observe, undefined, 'manual is not an observe-only preview path');
  assertEqual(calls.snapshot, 3, 'manual reads snapshot and rechecks before compose and install');
  assertEqual(installed.length, 1, 'manual installs one prompt through the scoped pipeline');
  assert(view.lastPacket, 'manual builds packet');
  assert(view.lastHand.cards.length > 0, 'manual builds hand');
  assertEqual(view.activity.label, 'Recursion prompt ready.', 'manual activity settles as prompt ready');
  assert(view.activityHistory.some((event) => event.chips?.includes('Manual')), 'manual activity history carries the mode chip');
  assertEqual(view.activeRunId, null, 'active run cleared after manual');
  const journal = await storage.loadRunJournal(view.lastSnapshot.chatKey);
  assertDeepEqual(journal.entries.map((entry) => entry.event), ['hand.selected', 'prompt.installed'], 'manual journals hand before prompt install');
  const handSelected = journal.entries.find((entry) => entry.event === 'hand.selected');
  const promptInstalled = journal.entries.find((entry) => entry.event === 'prompt.installed');
  assert(handSelected, 'manual appends hand selection journal');
  assert(promptInstalled, 'manual appends prompt install journal');
  assert(!JSON.stringify(handSelected).includes(view.lastHand.cards[0].promptText), 'manual hand journal omits prompt text');
  assertNoSecretText(handSelected, 'manual hand journal');
  assertNoSecretText(promptInstalled, 'manual prompt install journal');
}

{
  const { runtime, storage, adapter } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' }
  });
  await runtime.prepareForGeneration({ userMessage: 'Export diagnostics without raw prompt text.' });
  const before = await storage.loadRunJournal('chat-1');
  assert(before.entries.length > 0, 'runtime created run journal before maintenance clear');
  const exported = await runtime.exportDiagnostics();
  assertEqual(exported.ok, true, 'runtime diagnostics export succeeds');
  const serialized = assertNoSecretText(exported, 'runtime diagnostics export');
  assert(serialized.includes('recursion.diagnostics.v1'), 'diagnostics export includes schema');
  assert(serialized.includes('promptPacketHash'), 'diagnostics export includes prompt packet hash');
  assert(!serialized.includes('Scene brief:'), 'diagnostics export omits prompt packet sections');
  assert(!serialized.includes('The lamp breaks.'), 'diagnostics export omits transcript and card prompt text');
  assert(!serialized.includes('Export diagnostics without raw prompt text.'), 'diagnostics export omits pending user message text');

  const cleared = await runtime.clearRunJournal();
  assertEqual(cleared.ok, true, 'runtime clearRunJournal succeeds');
  assertEqual(runtime.view().activity.label, 'Run journal cleared.', 'runtime clearRunJournal surfaces success');
  assert(!Object.prototype.hasOwnProperty.call(adapter.dump(), 'recursion-run-journal-chat-1.v1.json'), 'runtime clearRunJournal deletes owned journal file');
  const afterIndex = await storage.readIndex();
  assert(!afterIndex.records['recursion-run-journal-chat-1.v1.json'], 'runtime clearRunJournal removes index entry');
}

{
  let releaseClear;
  let updateResolved = false;
  const { runtime, calls, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    hostPrompt: {
      async clear() {
        await new Promise((resolve) => {
          releaseClear = resolve;
        });
        return { ok: true, cleared: true };
      }
    }
  });
  const update = runtime.updateSettings({ enabled: false });
  update.then(() => {
    updateResolved = true;
  });
  await waitUntil(() => typeof releaseClear === 'function', 'power toggle change did not start prompt clear');
  assertEqual(updateResolved, false, 'power toggle change waits for prompt clear before resolving');
  assertEqual(runtime.view().settings.enabled, false, 'power toggle change updates enabled immediately');
  assertEqual(runtime.view().settings.mode, 'auto', 'power toggle change leaves mode unchanged');
  assertEqual(runtime.view().activity.phase, 'promptClearing', 'power toggle change surfaces prompt clear activity');
  releaseClear();
  const result = await update;
  const view = runtime.view();
  assertEqual(result.ok, true, 'power toggle change returns success when prompt clear succeeds');
  assertEqual(result.settings.enabled, false, 'power toggle change returns updated enabled state');
  assertEqual(result.clear.ok, true, 'power toggle change returns clear result');
  assertEqual(calls.clear, 1, 'power toggle change clears host prompt');
  assertEqual(view.activity.severity, 'success', 'power toggle change surfaces success activity');
  assertEqual(view.activity.label, 'Recursion disabled. Prompt cleared.', 'power toggle change has visible success label');
}

{
  let releaseClear;
  let updateResolved = false;
  const { runtime } = createRuntimeHarness({
    settings: { ui: { tooltipsEnabled: true } },
    hostPrompt: {
      async clear() {
        await new Promise((resolve) => {
          releaseClear = resolve;
        });
        return { ok: true, cleared: true };
      }
    }
  });
  const update = runtime.updateSettings({ ui: { tooltipsEnabled: false } });
  update.then(() => {
    updateResolved = true;
  });
  await waitUntil(() => typeof releaseClear === 'function', 'tooltip setting change did not start prompt clear');
  assertEqual(updateResolved, false, 'tooltip setting change waits for prompt clear before resolving');
  assertEqual(runtime.view().settings.ui.tooltipsEnabled, false, 'tooltip setting change updates runtime view immediately');
  releaseClear();
  const result = await update;
  assertEqual(result.settings.ui.tooltipsEnabled, false, 'tooltip setting change returns updated tooltip setting');
  assertEqual(runtime.view().settings.ui.tooltipsEnabled, false, 'tooltip setting change stays visible after prompt clear resolves');
}

{
  let releaseClear;
  const { runtime, calls, settingsStore } = createRuntimeHarness({
    settings: {
      strength: 'strong',
      injection: { depth: 7 },
      ui: { tooltipsEnabled: false },
      enabled: false,
      mode: 'manual'
    },
    hostPrompt: {
      async clear() {
        await new Promise((resolve) => {
          releaseClear = resolve;
        });
        return { ok: true, cleared: true };
      }
    }
  });
  settingsStore.updateProvider('utility', {
    source: 'openai-compatible',
    openAICompatible: { model: 'preserved-model' },
    apiKey: 'preserved-secret'
  });
  const reset = runtime.resetSettingsMenu();
  await waitUntil(() => typeof releaseClear === 'function', 'settings reset did not start prompt clear');
  assertEqual(runtime.view().settings.strength, 'balanced', 'settings reset restores Play settings immediately');
  assertEqual(runtime.view().settings.injection.depth, 1, 'settings reset restores Advanced settings immediately');
  assertEqual(runtime.view().settings.enabled, false, 'settings reset preserves compact-bar enabled state');
  assertEqual(runtime.view().settings.mode, 'manual', 'settings reset preserves compact-bar mode');
  assertEqual(runtime.view().settings.providers.utility.openAICompatible.model, 'preserved-model', 'settings reset preserves provider fields');
  releaseClear();
  const result = await reset;
  assertEqual(result.ok, true, 'settings reset returns success after prompt clear');
  assertEqual(result.reset, true, 'settings reset reports that values changed');
  assertEqual(result.clear.ok, true, 'settings reset returns prompt clear result');
  assertEqual(calls.clear, 1, 'settings reset clears host prompt once');
  assertEqual(settingsStore.getApiKey('utility'), 'preserved-secret', 'settings reset preserves provider session key');
  assertEqual(runtime.view().activity.label, 'Recursion settings reset to defaults. Providers and decks were preserved.', 'settings reset surfaces success label');
}

{
  let releaseClear;
  let updateResolved = false;
  const { runtime } = createRuntimeHarness({
    settings: { injection: { placement: 'in_prompt', role: 'system', depth: 1 } },
    hostPrompt: {
      async clear() {
        await new Promise((resolve) => {
          releaseClear = resolve;
        });
        return { ok: true, cleared: true };
      }
    }
  });
  const update = runtime.updateSettings({ injection: { depth: 7 } });
  update.then(() => {
    updateResolved = true;
  });
  await waitUntil(() => typeof releaseClear === 'function', 'injection depth change did not start prompt clear');
  assertEqual(updateResolved, false, 'injection depth change waits for prompt clear before resolving');
  assertEqual(runtime.view().settings.injection.depth, 7, 'injection depth change updates runtime view immediately');
  releaseClear();
  const result = await update;
  assertEqual(result.settings.injection.depth, 7, 'injection depth change returns updated injection depth');
  assertEqual(runtime.view().settings.injection.depth, 7, 'injection depth change stays visible after prompt clear resolves');
}

{
  const disabledSceneScope = setFamilyEnabled(defaultCardScope(), 'Scene Frame', false).scope;
  const { runtime } = createRuntimeHarness({
    settings: { cardScope: disabledSceneScope }
  });
  const view = runtime.view();
  assertEqual(view.settings.cardScope, undefined, 'runtime view omits legacy raw card scope');
  assertEqual(view.settings.cardDecks.defaultEnabledState['Scene Frame'].enabled, false, 'runtime view exposes migrated default deck enabled state');
  assertEqual(view.settings.cardScopeSummary.counts.selectedSubItems, 31, 'runtime view exposes separate card scope summary');
}

{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'manual', maxCards: 5, reasonerUse: 'off' }
  });
  const view = runtime.view();
  assertEqual(view.settings.maxCards, 5, 'runtime view exposes current Max Cards for Manual cap UI');
  assert(view.settings.cardScopeSummary.counts.selectedFamilies >= 1, 'runtime view keeps at least one selected family');
}

{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', maxCards: 2, cardScope: defaultCardScope(), reasonerUse: 'off' }
  });
  const update = await runtime.updateSettings({ mode: 'manual' });
  const expected = CARD_SCOPE_CATALOG.slice(0, 2).map((entry) => entry.family);
  assertDeepEqual(manualSelectedFamilies(activeCardDeckRuntimeScope(update.settings)), expected, 'Auto-to-Manual over cap trims by catalog priority without randomness');
  assertDeepEqual(manualSelectedFamilies(activeCardDeckRuntimeScope(runtime.view().settings)), expected, 'trimmed Manual scope is visible in runtime view');
}

{
  const keep = ['Scene Frame', 'Open Threads'];
  const underCap = scopeWithOnlyFamilies(keep);
  const firstSceneFacet = CARD_SCOPE_CATALOG.find((entry) => entry.family === 'Scene Frame').subItems[0].key;
  const focused = setSubItemEnabled(underCap, 'Scene Frame', firstSceneFacet, false).scope;
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', maxCards: 5, cardScope: focused, reasonerUse: 'off' }
  });
  const update = await runtime.updateSettings({ mode: 'manual' });
  const updatedScope = activeCardDeckRuntimeScope(update.settings);
  assertEqual(updatedScope.families['Scene Frame'].subItems[firstSceneFacet], false, 'under-cap Auto-to-Manual preserves selected facets');
  assertDeepEqual(normalizeCardScope(updatedScope), normalizeCardScope(focused), 'under-cap Auto-to-Manual preserves selected families and facets exactly');
}

{
  const { runtime, calls } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    hostPrompt: {
      async clear() {
        throw new Error('clear failed with Bearer clear-token, sk-clear-runtime, and private-secret');
      }
    }
  });
  const result = await runtime.updateSettings({ enabled: false });
  const view = runtime.view();
  assertEqual(result.ok, false, 'power toggle change returns non-ok when prompt clear fails');
  assertEqual(result.settings.enabled, false, 'power toggle disabled state still applies when prompt clear fails');
  assertEqual(result.clear.ok, false, 'power toggle change returns failed clear result');
  assertEqual(calls.clear, 1, 'power toggle clear failure still calls host prompt clear');
  assertEqual(view.activity.severity, 'warning', 'power toggle clear failure surfaces warning activity');
  assert(view.activity.label.includes('Prompt clear failed'), 'power toggle clear failure has visible warning label');
  assertNoSecretText(result, 'power toggle clear failure result');
  assertNoSecretText(view.activity, 'power toggle clear failure activity');
}

{
  const { runtime, calls } = createRuntimeHarness({
    settings: { mode: 'manual', reasoningLevel: 'high', reasonerUse: 'auto' }
  });
  const result = await runtime.updateSettings({ reasoningLevel: 'ultra', reasonerUse: 'always' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'reasoning level settings update succeeds');
  assertEqual(result.clear, null, 'reasoning level bar click does not perform prompt clear');
  assertEqual(calls.clear, 0, 'reasoning level bar click does not call host prompt clear');
  assertEqual(view.settings.reasoningLevel, 'ultra', 'reasoning level bar click updates runtime setting');
  assertEqual(view.settings.reasonerUse, 'always', 'reasoning level bar click updates derived reasoner use');
  assert(view.activity.phase !== 'promptClearing', 'reasoning level bar click does not surface prompt clearing activity');
}

{
  let releaseClear;
  let updateResolved = false;
  const { runtime, calls, settingsStore } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    hostPrompt: {
      async clear() {
        await new Promise((resolve) => {
          releaseClear = resolve;
        });
        return { ok: true, cleared: true };
      }
    }
  });
  const update = Promise.resolve(runtime.updateProvider('utility', {
    source: 'openai-compatible',
    apiKey: 'sk-runtime-secret',
    openAICompatible: { baseUrl: 'https://provider-change.test/v1', model: 'provider-change-model' }
  }));
  update.then(() => {
    updateResolved = true;
  });
  await waitUntil(() => typeof releaseClear === 'function', 'provider settings change did not start prompt clear');
  assertEqual(updateResolved, false, 'provider settings change waits for prompt clear before resolving');
  assertEqual(settingsStore.getApiKey('utility'), 'sk-runtime-secret', 'provider settings change stores key immediately');
  assertEqual(runtime.view().settings.providers.utility.openAICompatible.model, 'provider-change-model', 'provider settings change updates provider immediately');
  assertEqual(runtime.view().activity.phase, 'promptClearing', 'provider settings change surfaces prompt clear activity');
  releaseClear();
  const result = await update;
  const view = runtime.view();
  assertEqual(result.ok, true, 'provider settings change returns success when prompt clear succeeds');
  assertEqual(result.provider.openAICompatible.sessionApiKeyPresent, true, 'provider settings change returns updated provider');
  assertEqual(result.clear.ok, true, 'provider settings change returns clear result');
  assertEqual(calls.clear, 1, 'provider settings change clears host prompt');
  assertEqual(view.activity.severity, 'success', 'provider settings change surfaces success activity');
  assertEqual(view.activity.label, 'Recursion prompt cleared after provider change.', 'provider settings change has visible success label');
  assertNoSecretText(result, 'provider settings change result');
}

{
  let releaseFirstClear;
  let releaseSecondClear;
  let clearCalls = 0;
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    hostPrompt: {
      async clear() {
        clearCalls += 1;
        if (clearCalls === 1) {
          await new Promise((resolve) => {
            releaseFirstClear = resolve;
          });
          return { ok: true, cleared: true, call: 1 };
        }
        await new Promise((resolve) => {
          releaseSecondClear = resolve;
        });
        return { ok: true, cleared: true, call: 2 };
      }
    }
  });
  const first = runtime.updateProvider('utility', {
    openAICompatible: { baseUrl: 'https://first-provider.test/v1', model: 'first-provider-model' }
  });
  await waitUntil(() => typeof releaseFirstClear === 'function', 'first provider clear did not start');
  const second = runtime.updateProvider('utility', {
    openAICompatible: { baseUrl: 'https://second-provider.test/v1', model: 'second-provider-model' }
  });
  assertEqual(runtime.view().activity.label, 'Clearing Recursion prompt...', 'newer provider change owns visible prompt clear activity');
  releaseFirstClear();
  await first;
  assertEqual(runtime.view().activity.label, 'Clearing Recursion prompt...', 'older provider clear cannot settle while newer clear is pending');
  await waitUntil(() => typeof releaseSecondClear === 'function', 'second provider clear did not start');
  releaseSecondClear();
  const secondResult = await second;
  assertEqual(secondResult.ok, true, 'newer provider clear resolves successfully');
  assertEqual(runtime.view().activity.label, 'Recursion prompt cleared after provider change.', 'newer provider clear settles activity');
}

{
  const { runtime, calls, settingsStore } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    hostPrompt: {
      async clear() {
        throw new Error('clear failed with Bearer provider-clear-token, sk-provider-clear, and private-secret');
      }
    }
  });
  const result = await runtime.updateProvider('utility', {
    source: 'openai-compatible',
    apiKey: 'sk-runtime-secret',
    openAICompatible: { baseUrl: 'https://provider-fail.test/v1', model: 'provider-fail-model' }
  });
  const view = runtime.view();
  assertEqual(result.ok, false, 'provider settings change returns non-ok when prompt clear fails');
  assertEqual(result.provider.openAICompatible.model, 'provider-fail-model', 'provider settings still applies when prompt clear fails');
  assertEqual(settingsStore.getApiKey('utility'), 'sk-runtime-secret', 'provider key still applies when prompt clear fails');
  assertEqual(result.clear.ok, false, 'provider settings change returns failed clear result');
  assertEqual(calls.clear, 1, 'provider settings clear failure still calls host prompt clear');
  assertEqual(view.activity.severity, 'warning', 'provider settings clear failure surfaces warning activity');
  assert(view.activity.label.includes('Prompt clear failed'), 'provider settings clear failure has visible warning label');
  assertNoSecretText(result, 'provider settings clear failure result');
  assertNoSecretText(view.activity, 'provider settings clear failure activity');
}

{
  let releaseClear;
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    hostPrompt: {
      async clear() {
        await new Promise((resolve) => {
          releaseClear = resolve;
        });
        return { ok: true, cleared: true };
      }
    }
  });
  const update = runtime.updateProvider('utility', {
    openAICompatible: { baseUrl: 'https://provider-test-race.test/v1', model: 'provider-test-race-model' }
  });
  await waitUntil(() => typeof releaseClear === 'function', 'provider test race clear did not start');
  const providerTest = await runtime.testProvider('utility');
  assertEqual(providerTest.ok, false, 'provider test without router fails for activity ownership regression');
  assertEqual(runtime.view().activity.label, 'Utility provider test failed.', 'newer provider test owns visible activity before older clear resolves');
  releaseClear();
  await update;
  assertEqual(runtime.view().activity.label, 'Utility provider test failed.', 'older provider clear cannot overwrite newer provider test activity');
}

{
  let releaseClear;
  let clearResolved = false;
  const { runtime, calls, settingsStore } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    hostPrompt: {
      async clear() {
        await new Promise((resolve) => {
          releaseClear = resolve;
        });
        return { ok: true, cleared: true };
      }
    }
  });
  settingsStore.updateProvider('utility', {
    source: 'openai-compatible',
    apiKey: 'sk-runtime-secret',
    openAICompatible: { baseUrl: 'https://provider-key.test/v1', model: 'provider-key-model' }
  });
  const clear = Promise.resolve(runtime.clearProviderKey('utility'));
  clear.then(() => {
    clearResolved = true;
  });
  await waitUntil(() => typeof releaseClear === 'function', 'provider key clear did not start prompt clear');
  assertEqual(clearResolved, false, 'provider key clear waits for prompt clear before resolving');
  assertEqual(settingsStore.getApiKey('utility'), '', 'provider key clear removes session secret immediately');
  assertEqual(runtime.view().settings.providers.utility.openAICompatible.sessionApiKeyPresent, false, 'provider key clear updates provider immediately');
  assertEqual(runtime.view().activity.phase, 'promptClearing', 'provider key clear surfaces prompt clear activity');
  releaseClear();
  const result = await clear;
  const view = runtime.view();
  assertEqual(result.ok, true, 'provider key clear returns success when prompt clear succeeds');
  assertEqual(result.provider.openAICompatible.sessionApiKeyPresent, false, 'provider key clear returns updated provider');
  assertEqual(result.clear.ok, true, 'provider key clear returns clear result');
  assertEqual(calls.clear, 1, 'provider key clear clears host prompt');
  assertEqual(view.activity.severity, 'success', 'provider key clear surfaces success activity');
  assertEqual(view.activity.label, 'Recursion prompt cleared after provider key change.', 'provider key clear has visible success label');
  assertNoSecretText(result, 'provider key clear result');
}

{
  const { runtime, calls, installed, cleared } = createRuntimeHarness({
    settings: { enabled: false, mode: 'auto', reasonerUse: 'off' }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Skip this.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'disabled power state returns ok');
  assertEqual(result.skipped, true, 'disabled power state skipped');
  assertEqual(result.reason, 'disabled', 'disabled power state reason');
  assertEqual(calls.snapshot, 0, 'disabled power state does not read snapshot');
  assertEqual(installed.length, 0, 'disabled power state does not install');
  assertEqual(cleared.length, 1, 'disabled power state clears host prompt');
  assertEqual(view.activity.phase, 'idle', 'disabled power state clears activity');
  assertEqual(view.activeRunId, null, 'active run clear after disabled power state');
}

{
  const { runtime, calls } = createRuntimeHarness({
    settings: { enabled: false, mode: 'auto', reasonerUse: 'off' },
    hostPrompt: {
      async clear() {
        throw new Error('clear failed with Bearer clear-token, sk-clear-runtime, and private-secret');
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Clear fails.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'disabled power state still returns ok when clear fails');
  assertEqual(result.clear.ok, false, 'disabled power state reports clear warning');
  assertEqual(calls.snapshot, 0, 'disabled clear failure still skips snapshot');
  assertEqual(view.activity.severity, 'warning', 'disabled clear failure surfaces warning activity');
  assert(view.activity.label.includes('Prompt clear failed'), 'disabled clear failure has visible warning label');
  assertNoSecretText(result, 'disabled clear result');
}

{
  const { runtime, calls, installed, storage } = createRuntimeHarness({
    settings: { enabled: false, mode: 'auto', reasonerUse: 'off' },
    hostPrompt: { methods: { clear: undefined } }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Missing clear.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'disabled power state still skips when clear API is missing');
  assertEqual(result.clear.ok, false, 'missing clear returns non-ok clear outcome');
  assertEqual(result.clear.error.code, 'RECURSION_PROMPT_CLEAR_UNAVAILABLE', 'missing clear returns explicit error code');
  assertEqual(calls.snapshot, 0, 'missing clear disabled path still skips snapshot');
  assertEqual(calls.clear, 0, 'missing clear disabled path does not call host clear');
  assertEqual(installed.length, 0, 'missing clear disabled path does not install');
  assertEqual(view.activity.severity, 'warning', 'missing clear disabled path surfaces warning activity');
  assert(view.activity.label.includes('Prompt clear failed'), 'missing clear disabled path has visible warning label');
}

{
  const { runtime, calls, installed, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    hostPrompt: {
      async install() {
        throw new Error('install transport failed');
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Install fails.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'install exception remains fail-soft');
  assertEqual(result.install.ok, false, 'install exception preserves non-ok install outcome');
  assertEqual(calls.install, 1, 'install attempted once');
  assertEqual(installed.length, 1, 'failed install still received packet');
  assertEqual(view.activity.severity, 'warning', 'install failure settles warning');
  assertEqual(view.activity.label, 'Prompt install failed. Generation will continue without Recursion.', 'install failure label');
  assertEqual(view.lastBrief?.status, 'empty', 'failed prompt install does not report Last Brief as ready');
  assertEqual(view.activeRunId, null, 'active run cleared after install failure');
  const journal = await storage.loadRunJournal(view.lastSnapshot.chatKey);
  assertDeepEqual(journal.entries.map((entry) => entry.event), ['hand.selected', 'prompt.install_failed'], 'install failure journals hand before failure');
  const installFailed = journal.entries.find((entry) => entry.event === 'prompt.install_failed');
  assert(installFailed, 'install failure journaled');
  assert(installFailed.summary.includes('install transport failed'), 'install failure summary includes compact error');
}

{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    hostPrompt: {
      async install() {
        return {
          ok: false,
          error: {
            code: 'RETURNED_SECRET',
            message: 'returned failure with Bearer returned-token, sk-returned-runtime, and private-secret'
          },
          apiKey: 'sk-extra-field',
          installed: ['Bearer installed-token']
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Returned install failure.' });
  assertEqual(result.ok, true, 'returned install failure remains fail-soft');
  assertEqual(result.install.ok, false, 'returned install failure preserves non-ok install outcome');
  assertEqual(result.install.error.code, 'RETURNED_SECRET', 'returned install failure preserves safe code');
  assertNoSecretText(result, 'returned install result');
}

{
  const { runtime, calls, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    hostPrompt: { methods: { install: undefined } }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'No installer.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'missing host prompt install remains fail-soft');
  assertEqual(result.install.ok, false, 'missing installer preserves non-ok install outcome');
  assertEqual(calls.install, 0, 'missing installer is not called');
  assertEqual(result.install.error.code, 'RECURSION_PROMPT_INSTALL_UNAVAILABLE', 'missing installer returns explicit error code');
  assertEqual(view.activity.label, 'Prompt install failed. Generation will continue without Recursion.', 'missing installer warning label');
  assertEqual(view.activeRunId, null, 'active run cleared after missing installer');
  const journal = await storage.loadRunJournal(view.lastSnapshot.chatKey);
  assertDeepEqual(journal.entries.map((entry) => entry.event), ['hand.selected', 'prompt.install_failed'], 'missing installer journals hand before failure');
}

{
  let snapshotReads = 0;
  const firstTurn = {
    chatId: 'stale-chat',
    chatKey: 'stale-chat',
    sceneKey: 'stale-scene',
    sceneFingerprint: 'stale-scene',
    turnFingerprint: 'stale-turn-1',
    latestMesId: 10,
    messages: [
      { mesid: 10, role: 'user', text: 'First pending turn.', visible: true }
    ]
  };
  const movedTurn = {
    ...firstTurn,
    turnFingerprint: 'stale-turn-2',
    latestMesId: 11,
    messages: [
      ...firstTurn.messages,
      { mesid: 11, role: 'assistant', text: 'The host has moved on.', visible: true }
    ]
  };
  const { runtime, calls, installed, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => {
      snapshotReads += 1;
      return snapshotReads === 1 ? firstTurn : movedTurn;
    },
    hostPrompt: {
      async install() {
        throw new Error('stale prompt install should not be called');
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'First pending turn.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'stale prompt install returns nonfatal ok');
  assertEqual(result.skipped, true, 'stale prompt install is skipped');
  assertEqual(result.reason, 'stale-snapshot', 'stale prompt install reports stale snapshot reason');
  assertEqual(calls.snapshot, 2, 'runtime rechecks host snapshot before prompt install');
  assertEqual(calls.install, 0, 'stale snapshot does not call host prompt install');
  assertEqual(installed.length, 0, 'stale snapshot does not write prompt packet');
  assertEqual(view.activity.severity, 'warning', 'stale install skip surfaces warning activity');
  assert(view.activity.label.includes('Recursion skipped'), 'stale install skip has visible status label');
  const journal = await storage.loadRunJournal(firstTurn.chatKey);
  assertEqual(journal.entries[0].event, 'prompt.install_skipped', 'stale install skip is journaled');
}

{
  let snapshotReads = 0;
  const pendingText = 'Live host keeps this pending user text.';
  const firstTurn = {
    chatId: 'pending-hash-chat',
    chatKey: 'pending-hash-chat',
    sceneKey: 'pending-hash-scene',
    sceneFingerprint: 'pending-hash-scene',
    turnFingerprint: 'pending-hash-turn-1',
    latestMesId: 30,
    messages: [
      { mesid: 29, role: 'assistant', text: 'Stable prefix message.', swipeCount: 1, visible: true },
      { mesid: 30, role: 'user', text: pendingText, textHash: hashJson(pendingText), visible: true }
    ]
  };
  const recheckedTurn = {
    ...firstTurn,
    turnFingerprint: 'pending-hash-turn-2',
    sourceRevisionHash: '',
    messages: [
      { ...firstTurn.messages[0], swipeCount: 2, activeSwipeTextHash: hashJson('Stable prefix message.') },
      { ...firstTurn.messages[1], textHash: hashJson(`${pendingText}:host-mutated`) }
    ]
  };
  const { runtime, calls, installed, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => {
      snapshotReads += 1;
      return snapshotReads === 1 ? firstTurn : recheckedTurn;
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: { text: pendingText, mesid: 30 } });
  assertEqual(result.ok, true, 'pending user hash churn remains installable when text and turn are unchanged');
  assertEqual(result.skipped, undefined, 'pending user hash churn does not report stale skip');
  assert(calls.snapshot >= 2, 'pending user hash churn still rechecks host snapshot');
  assertEqual(calls.install, 1, 'pending user hash churn installs prompt');
  assertEqual(installed.length, 1, 'pending user hash churn writes one prompt packet');
  const journal = await storage.loadRunJournal(firstTurn.chatKey);
  assert(!journal.entries.some((entry) => entry.event === 'prompt.install_skipped'), 'pending user hash churn is not journaled as skipped');
}

{
  let snapshotReads = 0;
  const currentTurn = {
    chatId: 'recheck-fail-chat',
    chatKey: 'recheck-fail-chat',
    sceneKey: 'recheck-fail-scene',
    sceneFingerprint: 'recheck-fail-scene',
    turnFingerprint: 'recheck-fail-turn',
    latestMesId: 20,
    messages: [
      { mesid: 20, role: 'user', text: 'Snapshot recheck should fail closed.', visible: true }
    ]
  };
  const { runtime, calls, installed, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => {
      snapshotReads += 1;
      if (snapshotReads === 1) return currentTurn;
      throw new Error('snapshot recheck failed with Bearer recheck-token and sk-recheck-runtime');
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Snapshot recheck should fail closed.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'failed snapshot recheck returns nonfatal ok');
  assertEqual(result.skipped, true, 'failed snapshot recheck skips prompt install');
  assertEqual(result.reason, 'snapshot-recheck-failed', 'failed snapshot recheck reports reason');
  assertEqual(calls.snapshot, 2, 'failed recheck still attempts final host snapshot');
  assertEqual(calls.install, 0, 'failed snapshot recheck does not call host prompt install');
  assertEqual(installed.length, 0, 'failed snapshot recheck does not write prompt packet');
  assertEqual(view.activity.severity, 'warning', 'failed snapshot recheck surfaces warning activity');
  assertNoSecretText(result, 'snapshot recheck failure result');
  assertNoSecretText(view.activity, 'snapshot recheck failure activity');
  const journal = await storage.loadRunJournal(currentTurn.chatKey);
  assertDeepEqual(journal.entries.map((entry) => entry.event), ['prompt.install_skipped'], 'failed snapshot recheck skip is journaled without hand commit');
  assertEqual(journal.entries[0].details.reason, 'snapshot-recheck-failed', 'failed snapshot recheck journal records reason');
  assertNoSecretText(journal.entries[0], 'snapshot recheck failure journal');
}

{
  const activity = createActivityReporter();
  const storage = {
    async loadSceneCache() {
      throw new Error('load failed with Bearer load-token, sk-load-runtime, and private-secret');
    },
    async saveSceneCache() {
      return {};
    },
    async appendJournal() {
      return {};
    }
  };
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    activity
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Load cache fails.' });
  assertEqual(result.ok, true, 'throwing scene cache load does not abort runtime');
  assertEqual(installed.length, 1, 'throwing scene cache load still installs prompt');
  const serializedHistory = JSON.stringify(activity.history());
  assert(serializedHistory.includes('"operation":"loadSceneCache"'), 'load failure warning is surfaced');
  assert(!serializedHistory.includes('Bearer load-token'), 'load failure warning redacts bearer token');
  assert(!serializedHistory.includes('sk-load-runtime'), 'load failure warning redacts sk token');
  assert(!serializedHistory.includes('private-secret'), 'load failure warning redacts private secret');
}

{
  const activity = createActivityReporter();
  let appendCalls = 0;
  const storage = {
    async loadSceneCache() {
      return null;
    },
    async saveSceneCache() {
      throw new Error('save failed with Bearer save-token, sk-save-runtime, and private-secret');
    },
    async appendJournal() {
      appendCalls += 1;
      return {};
    }
  };
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    activity
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Save cache fails.' });
  assertEqual(result.ok, true, 'throwing scene cache save does not abort runtime');
  assertEqual(installed.length, 1, 'throwing scene cache save still installs prompt');
  assertEqual(appendCalls, 2, 'throwing scene cache save still appends hand and install journals');
  const serializedHistory = JSON.stringify(activity.history());
  assert(serializedHistory.includes('"operation":"saveSceneCache"'), 'save failure warning is surfaced');
  assert(!serializedHistory.includes('Bearer save-token'), 'save failure warning redacts bearer token');
  assert(!serializedHistory.includes('sk-save-runtime'), 'save failure warning redacts sk token');
  assert(!serializedHistory.includes('private-secret'), 'save failure warning redacts private secret');
}

{
  const activity = createActivityReporter();
  const files = new Map();
  const fallbackRepository = createStorageRepository({
    storage: {
      async readJson(key) {
        return files.has(key) ? files.get(key) : null;
      },
      async writeJson(key, value) {
        files.set(key, value);
        return { ok: true, key, fallback: 'memory', detail: 'Bearer fallback-token sk-fallback-runtime private-secret' };
      },
      async deleteJson(key) {
        files.delete(key);
        return { ok: true, key, fallback: 'memory' };
      }
    },
    activity
  });
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage: fallbackRepository,
    activity
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Storage fallback is visible.' });
  const serializedHistory = JSON.stringify(activity.history());
  assertEqual(result.ok, true, 'memory fallback storage does not abort runtime');
  assertEqual(installed.length, 1, 'memory fallback storage still allows prompt install');
  assert(serializedHistory.includes('"phase":"storageWarning"'), 'memory fallback storage warning is surfaced');
  assert(serializedHistory.includes('"fallback":"memory"'), 'memory fallback storage warning records fallback type');
  assert(!serializedHistory.includes('Bearer fallback-token'), 'memory fallback warning redacts bearer token');
  assert(!serializedHistory.includes('sk-fallback-runtime'), 'memory fallback warning redacts sk token');
  assert(!serializedHistory.includes('private-secret'), 'memory fallback warning redacts private secret');
}

{
  const activity = createActivityReporter();
  const storage = {
    async loadSceneCache() {
      return null;
    },
    async saveSceneCache() {
      return {};
    },
    async appendJournal() {
      throw new Error('append failed with Bearer journal-token, sk-journal-runtime, and private-secret');
    }
  };
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    activity
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Append journal fails.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'throwing journal append does not abort runtime');
  assertEqual(installed.length, 1, 'throwing journal append happens after prompt install');
  assertEqual(view.activity.label, 'Recursion prompt ready.', 'journal append failure still settles successful install');
  const serializedHistory = JSON.stringify(activity.history());
  assert(serializedHistory.includes('"operation":"appendJournal"'), 'append failure warning is surfaced');
  assert(!serializedHistory.includes('Bearer journal-token'), 'append failure warning redacts bearer token');
  assert(!serializedHistory.includes('sk-journal-runtime'), 'append failure warning redacts sk token');
  assert(!serializedHistory.includes('private-secret'), 'append failure warning redacts private secret');
}

{
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: healthyReasonerSettings({ mode: 'auto', promptFootprint: 'rich', reasoningLevel: 'low' }),
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push({ roleId, request });
        if (roleId !== 'utilityArbiter') {
          return {
            ok: true,
            roleId,
            data: {
              schema: 'recursion.card.v1',
              role: 'openThreadsCard',
              family: 'Open Threads',
              snapshotHash: request.snapshotHash,
              items: [{
                promptText: 'The unanswered signal still needs a response.',
                evidenceRefs: ['message:2'],
                tokenEstimate: 18
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
              guidanceText: 'Fallback guidance from local cards.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['fallback-guidance']
            }
          };
        }
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            cardJobs: [{ family: 'Open Threads', reason: 'Need one open thread card.' }],
            budgets: { targetBriefTokens: 60, maxCards: 1 },
            reasonerDecision: { mode: 'use', reason: 'arbiter requested reasoner', signals: ['test'] },
            diagnostics: ['router-plan']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Router budgets.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'router arbiter success still installs');
  assertDeepEqual(view.lastPlan.cardJobs, [{ family: 'Open Threads', reason: 'Need one open thread card.' }], 'router card jobs merged');
  assertEqual(view.lastPlan.budgets.maxCards, 1, 'router maxCards budget merged');
  assertEqual(view.lastPlan.budgets.targetBriefTokens, 60, 'router token budget merged');
  assertEqual(view.lastPlan.reasonerDecision.mode, 'use', 'arbiter reasoner decision preserved in plan');
  assertEqual(view.lastHand.cards.length, 1, 'router card budget changes selected hand');
  assertEqual(view.lastPacket.diagnostics.reasonerStatus, 'skipped', 'low reasoning level skips reasoner routing');
  assert(!routerCalls.some((call) => call.roleId === 'reasonerComposer'), 'reasoner composer not called when reasoning level is low');
}

{
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: healthyReasonerSettings({ mode: 'auto', promptFootprint: 'normal', reasoningLevel: 'low' }),
    generationRouter: {
      async generate(roleId, request = {}) {
        routerCalls.push({ roleId, lane: request.lane || 'utility' });
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              cardJobs: [
                { family: 'Scene Frame', reason: 'Scene still matters.' },
                { family: 'Active Cast', reason: 'Cast still matters.' },
                { family: 'Scene Constraints', reason: 'Scene constraints still matter.' },
                { family: 'Open Threads', reason: 'Thread still matters.' }
              ],
              budgets: { targetBriefTokens: 500, maxCards: 6 },
              reasonerDecision: { mode: 'use', reason: 'low must still suppress reasoner', signals: ['test'] }
            }
          };
        }
        if (roleId === 'reasonerComposer') {
          throw new Error('low reasoning must not call reasonerComposer');
        }
        return cardProviderResponse(roleId, request);
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Keep this lean.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'low reasoning capped run installs');
  assertEqual(view.lastPlan.budgets.maxCards, 3, 'low reasoning caps max selected cards to the most relevant few');
  assertEqual(view.lastHand.cards.length, 3, 'low reasoning selects only the capped hand size');
  assert(routerCalls.every((call) => call.lane === 'utility'), 'low reasoning routes Arbiter, cards, and composer work through Utility only');
}

for (const scenario of [
  { level: 'low', expectedMaxCards: 4, expectedReasonerCall: false },
  { level: 'medium', expectedMaxCards: 8, expectedReasonerCall: true },
  { level: 'high', expectedMaxCards: 8, expectedReasonerCall: true },
  { level: 'ultra', expectedMaxCards: 12, expectedReasonerCall: true }
]) {
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: healthyReasonerSettings({
      mode: 'auto',
      promptFootprint: 'rich',
      reasoningLevel: scenario.level,
      minCards: 4,
      maxCards: 12
    }),
    generationRouter: {
      async generate(roleId, request = {}) {
        routerCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              cardJobs: [
                { family: 'Scene Frame', reason: 'Scene still matters.' },
                { family: 'Active Cast', reason: 'Cast still matters.' },
                { family: 'Scene Constraints', reason: 'Scene constraints still matter.' },
                { family: 'Open Threads', reason: 'Thread still matters.' }
              ],
              budgets: { targetBriefTokens: 900, maxCards: scenario.level === 'ultra' ? 6 : 20 },
              reasonerDecision: { mode: 'use', reason: 'reasoning card budget test', signals: ['test'] }
            }
          };
        }
        if (roleId === 'reasonerComposer') return reasonerComposerResponse(request, `${scenario.level} synthesis.`);
        return cardProviderResponse(roleId, request);
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: `Use custom ${scenario.level} card budget.` });
  const view = runtime.view();
  assertEqual(result.ok, true, `${scenario.level} custom card budget run installs`);
  assertEqual(view.lastPlan.budgets.maxCards, scenario.expectedMaxCards, `${scenario.level} reasoning uses configured card budget`);
  assertEqual(routerCalls.includes('reasonerComposer'), scenario.expectedReasonerCall, `${scenario.level} custom card budget keeps expected composer routing`);
}

{
  const { runtime } = createRuntimeHarness({
    settings: healthyReasonerSettings({
      mode: 'auto',
      strength: 'light',
      focus: 'character',
      promptFootprint: 'compact',
      reasonerUse: 'off',
      reasoningLevel: 'high'
    }),
    generationRouter: {
      async generate(roleId, request = {}) {
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              promptFootprint: 'rich',
              cardJobs: [
                { family: 'Scene Frame', reason: 'Scene still matters.' },
                { family: 'Active Cast', reason: 'Cast still matters.' },
                { family: 'Character Motivation', reason: 'Motivation still matters.' },
                { family: 'Relationship', reason: 'Relationship still matters.' },
                { family: 'Scene Constraints', reason: 'Scene constraints still matter.' },
                { family: 'Open Threads', reason: 'Thread still matters.' }
              ],
              budgets: { targetBriefTokens: 1200, maxCards: 9 },
              reasonerDecision: { mode: 'skip', reason: 'policy test', signals: [] },
              diagnostics: ['provider-rich-request']
            }
          };
        }
        return cardProviderResponse(roleId, request);
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Keep it lean but character-aware.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'behavior policy run installs');
  assertEqual(view.lastPlan.promptFootprint, 'compact', 'compact setting clamps Arbiter rich footprint without high-risk reason');
  assertEqual(view.lastPlan.budgets.maxCards, 6, 'high reasoning uses the configured normal card budget even under compact footprint');
  assert(view.lastPlan.diagnostics.includes('behavior-footprint-clamped'), 'plan records footprint clamp diagnostic');
  assert(!view.lastPlan.diagnostics.includes('behavior-max-cards-clamped'), 'compact footprint no longer records a card-count clamp');
  assertEqual(view.lastHand.cards.length, 5, 'light strength applies lean hand pressure after normal card budget');
  assertEqual(view.lastPacket.footprint, 'compact', 'packet uses effective compact footprint');
  assertEqual(view.lastPacket.diagnostics.behaviorPolicy.strength, 'light', 'packet diagnostics record light strength');
  assertEqual(view.lastPacket.diagnostics.behaviorPolicy.focus, 'character', 'packet diagnostics record character focus');
  assertEqual(view.lastPacket.diagnostics.behaviorPolicy.effectiveFootprint, 'compact', 'packet diagnostics record compact footprint');
  assert(view.lastPacket.diagnostics.behaviorPolicy.strength === 'light', 'packet diagnostics include light strength');
  assert(view.lastPacket.diagnostics.behaviorPolicy.focus === 'character', 'packet diagnostics include character focus');
}

{
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: healthyReasonerSettings({ mode: 'auto', promptFootprint: 'normal', reasoningLevel: 'medium' }),
    generationRouter: {
      async generate(roleId, request = {}) {
        routerCalls.push({
          roleId,
          lane: request.lane || 'utility',
          reasoningCategory: request.reasoningCategory,
          reasoningIntent: request.reasoningIntent
        });
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              cardJobs: [],
              budgets: { targetBriefTokens: 500, maxCards: 6 },
              reasonerDecision: { mode: 'skip', reason: 'medium still composes with reasoner', signals: ['test'] }
            }
          };
        }
        if (roleId === 'reasonerComposer') return reasonerComposerResponse(request, 'Medium Reasoner composition.');
        throw new Error(`unexpected role ${roleId}`);
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Compose this with the Reasoner.' });
  assertEqual(result.ok, true, 'medium reasoning installs');
  assert(routerCalls.some((call) => call.roleId === 'reasonerComposer'), 'medium reasoning invokes Reasoner composer even when Arbiter skips optional reasoner use');
  assertEqual(routerCalls.find((call) => call.roleId === 'utilityArbiter')?.lane, 'utility', 'medium reasoning keeps Arbiter on Utility');
  assertEqual(routerCalls.find((call) => call.roleId === 'reasonerComposer')?.reasoningCategory, 'final-brief', 'medium reasoning labels Reasoner composer as final-brief work');
  assertEqual(routerCalls.find((call) => call.roleId === 'reasonerComposer')?.reasoningIntent, 'medium', 'medium reasoning asks the Reasoner composer for medium provider reasoning');
}

{
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: healthyReasonerSettings({ mode: 'auto', promptFootprint: 'normal', reasoningLevel: 'high' }),
    generationRouter: {
      async generate(roleId, request = {}) {
        routerCalls.push({
          roleId,
          lane: request.lane || 'utility',
          reasoningCategory: request.reasoningCategory,
          reasoningIntent: request.reasoningIntent
        });
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              cardJobs: [
                { family: 'Scene Frame', reason: 'High relevance scene frame.' },
                { family: 'Open Threads', reason: 'Lower-priority thread card.' }
              ],
              budgets: { targetBriefTokens: 500, maxCards: 6 },
              reasonerDecision: { mode: 'skip', reason: 'high still uses reasoner routes', signals: ['test'] }
            }
          };
        }
        if (roleId === 'reasonerComposer') return reasonerComposerResponse(request, 'High Reasoner synthesis.');
        return cardProviderResponse(roleId, request);
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Use mixed reasoning.' });
  assertEqual(result.ok, true, 'high reasoning installs');
  assertEqual(routerCalls.find((call) => call.roleId === 'utilityArbiter')?.lane, 'reasoner', 'high reasoning routes Arbiter through Reasoner');
  assertEqual(routerCalls.find((call) => call.roleId === 'sceneFrameCard')?.lane, 'reasoner', 'high reasoning routes high-priority cards through Reasoner');
  assertEqual(routerCalls.find((call) => call.roleId === 'openThreadsCard')?.lane, 'utility', 'high reasoning leaves lower-priority cards on Utility');
  assert(routerCalls.some((call) => call.roleId === 'reasonerComposer' && call.lane === 'reasoner'), 'high reasoning routes final composition through Reasoner');
  assertEqual(routerCalls.find((call) => call.roleId === 'utilityArbiter')?.reasoningCategory, 'arbiter', 'high reasoning labels Reasoner Arbiter work');
  assertEqual(routerCalls.find((call) => call.roleId === 'utilityArbiter')?.reasoningIntent, 'medium', 'high reasoning asks the Reasoner Arbiter for medium provider reasoning');
  assertEqual(routerCalls.find((call) => call.roleId === 'sceneFrameCard')?.reasoningCategory, 'card', 'high reasoning labels Reasoner card work');
  assertEqual(routerCalls.find((call) => call.roleId === 'sceneFrameCard')?.reasoningIntent, 'minimal', 'high reasoning keeps Reasoner card generation at minimal provider reasoning');
  assertEqual(routerCalls.find((call) => call.roleId === 'reasonerComposer')?.reasoningCategory, 'final-brief', 'high reasoning labels Reasoner composer as final-brief work');
  assertEqual(routerCalls.find((call) => call.roleId === 'reasonerComposer')?.reasoningIntent, 'medium', 'high reasoning asks the Reasoner composer for medium provider reasoning');
  assertEqual(runtime.view().lastPlan.budgets.maxCards, 6, 'high reasoning keeps normal card budget pressure');
}

{
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: healthyReasonerSettings({ mode: 'auto', promptFootprint: 'normal', reasoningLevel: 'ultra' }),
    generationRouter: {
      async generate(roleId, request = {}) {
        routerCalls.push({
          roleId,
          lane: request.lane || 'utility',
          reasoningCategory: request.reasoningCategory,
          reasoningIntent: request.reasoningIntent
        });
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              cardJobs: [
                { family: 'Scene Frame', reason: 'Scene frame.' },
                { family: 'Open Threads', reason: 'Thread card.' },
                { family: 'Environment', reason: 'Style card.' }
              ],
              budgets: { targetBriefTokens: 700, maxCards: 6 },
              reasonerDecision: { mode: 'skip', reason: 'ultra still uses reasoner routes', signals: ['test'] }
            }
          };
        }
        if (roleId === 'reasonerComposer') return reasonerComposerResponse(request, 'Ultra Reasoner synthesis.');
        return cardProviderResponse(roleId, request);
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Use the broadest reasoning pass.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'ultra reasoning installs');
  assertEqual(routerCalls.find((call) => call.roleId === 'utilityArbiter')?.lane, 'reasoner', 'ultra reasoning routes Arbiter through Reasoner');
  assert(routerCalls.filter((call) => call.roleId.endsWith('Card')).every((call) => call.lane === 'reasoner'), 'ultra reasoning routes generated card calls through Reasoner');
  assert(routerCalls.some((call) => call.roleId === 'reasonerComposer' && call.lane === 'reasoner'), 'ultra reasoning routes final composition through Reasoner');
  assertEqual(routerCalls.find((call) => call.roleId === 'utilityArbiter')?.reasoningCategory, 'arbiter', 'ultra reasoning labels Reasoner Arbiter work');
  assertEqual(routerCalls.find((call) => call.roleId === 'utilityArbiter')?.reasoningIntent, 'medium', 'ultra reasoning keeps Reasoner Arbiter at medium provider reasoning');
  assert(routerCalls.filter((call) => call.roleId.endsWith('Card')).every((call) => call.reasoningCategory === 'card'), 'ultra reasoning labels every Reasoner card request');
  assert(routerCalls.filter((call) => call.roleId.endsWith('Card')).every((call) => call.reasoningIntent === 'medium'), 'ultra reasoning asks Reasoner card generation for medium provider reasoning');
  assertEqual(routerCalls.find((call) => call.roleId === 'reasonerComposer')?.reasoningCategory, 'final-brief', 'ultra reasoning labels Reasoner composer as final-brief work');
  assertEqual(routerCalls.find((call) => call.roleId === 'reasonerComposer')?.reasoningIntent, 'high', 'ultra reasoning asks the Reasoner composer for high provider reasoning');
  assertEqual(view.lastPlan.budgets.maxCards, 10, 'ultra reasoning raises max card pressure for larger relevant hands');
}

{
  const { runtime, installed, settingsStore } = createRuntimeHarness({
    settings: { mode: 'auto', promptFootprint: 'normal', reasoningLevel: 'low' },
    generationRouter: {
      async generate(roleId, request) {
        assertEqual(roleId, 'utilityArbiter', 'compact footprint override only calls utility arbiter');
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            promptFootprint: 'compact',
            budgets: { targetBriefTokens: 500, maxCards: 6 },
            diagnostics: ['compact-footprint-override']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Use compact footprint this turn.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'arbiter compact footprint run installs');
  assertEqual(result.plan.promptFootprint, 'compact', 'result plan exposes sanitized arbiter compact footprint');
  assertEqual(view.lastPlan.promptFootprint, 'compact', 'view plan exposes sanitized arbiter compact footprint');
  assertEqual(view.lastPacket.footprint, 'compact', 'last packet uses arbiter compact footprint');
  assertEqual(installed[0].footprint, 'compact', 'installed packet uses arbiter compact footprint');
  assertEqual(settingsStore.get().promptFootprint, 'normal', 'arbiter footprint does not mutate stored setting');
}

{
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: healthyReasonerSettings({ mode: 'auto', promptFootprint: 'compact', reasonerUse: 'auto' }),
    generationRouter: {
      async generate(roleId, request = {}) {
        routerCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              promptFootprint: 'rich',
              reasonerDecision: { mode: 'use', reason: 'rich turn needs synthesis', signals: ['rich-footprint'] },
              budgets: { targetBriefTokens: 900, maxCards: 6 }
            }
          };
        }
        if (roleId === 'reasonerComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.reasonerComposer.v1',
              snapshotHash: parseReasonerPromptSnapshotHash(request.prompt),
              instructionPatch: 'Use the richer synthesis for this turn.',
              keptCardIds: [],
              droppedCardIds: []
            }
          };
        }
        throw new Error(`unexpected role ${roleId}`);
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Use rich footprint with reasoner.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'arbiter rich footprint run installs');
  assertEqual(view.lastPlan.promptFootprint, 'compact', 'compact behavior policy clamps arbiter rich footprint without high-risk reason');
  assertEqual(view.lastPacket.footprint, 'compact', 'last packet uses clamped compact footprint');
  assert(!routerCalls.includes('reasonerComposer'), 'non-risk rich Arbiter request does not invoke Reasoner after compact clamp');
  assertEqual(view.lastPacket.diagnostics.composerLane, 'utility', 'clamped non-risk rich request stays on Utility composer lane');
  assertEqual(view.lastPacket.diagnostics.behaviorPolicy.storedFootprint, 'compact', 'diagnostics preserve stored compact footprint');
  assertEqual(view.lastPacket.diagnostics.behaviorPolicy.effectiveFootprint, 'compact', 'diagnostics record compact effective footprint');
}

{
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: healthyReasonerSettings({ mode: 'auto', promptFootprint: 'compact', reasonerUse: 'auto' }),
    generationRouter: {
      async generate(roleId, request = {}) {
        routerCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              promptFootprint: 'rich',
              reasonerDecision: { mode: 'use', reason: 'high-risk continuity contradiction needs synthesis', signals: ['continuity-risk'] },
              budgets: { targetBriefTokens: 900, maxCards: 9 },
              diagnostics: ['footprint-risk-override']
            }
          };
        }
        if (roleId === 'reasonerComposer') {
          return reasonerComposerResponse(request, 'Use richer synthesis only for the high-risk continuity conflict.');
        }
        return cardProviderResponse(roleId, request);
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Resolve the continuity contradiction.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'high-risk footprint override installs');
  assertEqual(view.lastPlan.promptFootprint, 'rich', 'high-risk Arbiter request can temporarily use rich footprint');
  assertEqual(view.lastPacket.footprint, 'rich', 'packet uses effective rich footprint for high-risk override');
  assert(routerCalls.includes('reasonerComposer'), 'high-risk rich override can invoke Reasoner');
  assertEqual(view.lastPacket.diagnostics.behaviorPolicy.storedFootprint, 'compact', 'diagnostics preserve stored compact footprint during override');
  assertEqual(view.lastPacket.diagnostics.behaviorPolicy.effectiveFootprint, 'rich', 'diagnostics record effective rich footprint during override');
}

for (const scenario of [
  {
    label: 'disabled reasoner',
    settings: { mode: 'auto', promptFootprint: 'rich' },
    expectedReason: 'reasoner-disabled'
  },
  {
    label: 'failed reasoner test',
    settings: healthyReasonerSettings({
      mode: 'auto',
      promptFootprint: 'rich',
      providers: {
        reasoner: {
          lastTest: { status: 'fail', compactError: 'Bearer reasoner-token sk-reasoner-runtime private-secret' }
        }
      }
    }),
    expectedReason: 'reasoner-unhealthy'
  },
  {
    label: 'untested reasoner',
    settings: {
      mode: 'auto',
      promptFootprint: 'rich',
      providers: {
        reasoner: { enabled: true }
      }
    },
    expectedReason: 'reasoner-not-tested'
  },
  {
    label: 'missing direct reasoner key',
    settings: healthyReasonerSettings({
      mode: 'auto',
      promptFootprint: 'rich',
      providers: {
        reasoner: {
          source: 'openai-compatible',
          openAICompatible: { baseUrl: 'https://reasoner.test/v1', model: 'reasoner-model' }
        }
      }
    }),
    expectedReason: 'reasoner-key-missing'
  },
  {
    label: 'missing profile reasoner id',
    settings: healthyReasonerSettings({
      mode: 'auto',
      promptFootprint: 'rich',
      providers: {
        reasoner: {
          source: 'host-connection-profile',
          hostConnectionProfileId: ''
        }
      }
    }),
    expectedReason: 'reasoner-profile-missing'
  }
]) {
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: scenario.settings,
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              reasonerDecision: { mode: 'use', reason: `${scenario.label} should be gated`, signals: ['health-gate'] },
              budgets: { targetBriefTokens: 900, maxCards: 6 }
            }
          };
        }
        throw new Error(`${scenario.label} should not call reasonerComposer`);
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: `Gate ${scenario.label}.` });
  const view = runtime.view();
  assertEqual(result.ok, true, `${scenario.label} run still installs Utility packet`);
  assert(!routerCalls.includes('reasonerComposer'), `${scenario.label} suppresses reasoner composer`);
  assertEqual(result.plan.reasonerDecision.mode, 'skip', `${scenario.label} rewrites plan reasoner decision to skip`);
  assertEqual(result.plan.reasonerDecision.reason, scenario.expectedReason, `${scenario.label} records stable reasoner gate reason`);
  assert(result.plan.reasonerDecision.signals.includes('health-gate'), `${scenario.label} preserves Arbiter signal for diagnostics`);
  assert(result.plan.diagnostics.includes('reasoner-unavailable'), `${scenario.label} records reasoner unavailable diagnostic`);
  assertEqual(view.lastPacket.diagnostics.reasonerStatus, 'skipped', `${scenario.label} composes with Utility only`);
  assertNoSecretText(result.plan, `${scenario.label} plan`);
}

{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', promptFootprint: 'compact', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        assertEqual(roleId, 'utilityArbiter', 'invalid footprint fallback only calls utility arbiter');
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            promptFootprint: 'oversized-secret-mode',
            budgets: { targetBriefTokens: 500, maxCards: 6 },
            diagnostics: ['invalid-footprint-fallback']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Reject invalid footprint.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'invalid arbiter footprint falls back and installs');
  assertEqual(result.plan.promptFootprint, 'compact', 'result plan falls back to stored compact footprint');
  assertEqual(view.lastPlan.promptFootprint, 'compact', 'view plan falls back to stored compact footprint');
  assertEqual(view.lastPacket.footprint, 'compact', 'last packet uses stored compact footprint fallback');
  assert(!JSON.stringify(result.plan).includes('oversized-secret-mode'), 'invalid arbiter footprint is not exposed in result plan');
}

{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        assertEqual(roleId, 'utilityArbiter', 'invalid scene status fallback only calls utility arbiter');
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            sceneStatus: 'hard_shift',
            budgets: { targetBriefTokens: 500, maxCards: 6 },
            diagnostics: ['invalid-scene-status-fallback']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Reject old scene status.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'invalid arbiter scene status falls back and installs');
  assertEqual(result.plan.sceneStatus, 'same-scene', 'result plan falls back to V1 scene status');
  assertEqual(view.lastPlan.sceneStatus, 'same-scene', 'view plan falls back to V1 scene status');
  assert(!JSON.stringify(result.plan).includes('hard_shift'), 'invalid arbiter scene status is not exposed in result plan');
}

{
  let arbiterPrompt = '';
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: {
      chatId: 'pending-chat',
      chatKey: 'pending-chat',
      sceneKey: 'pending-scene',
      sceneFingerprint: 'pending-scene-fp',
      turnFingerprint: 'pending-old-turn-fp',
      latestMesId: 7,
      messages: [
        { mesid: 7, role: 'assistant', text: 'The previous assistant reply is already committed.', visible: true }
      ]
    },
    generationRouter: {
      async generate(roleId, request) {
        assertEqual(roleId, 'utilityArbiter', 'pending user message merge only needs Utility Arbiter');
        arbiterPrompt = request.prompt;
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'skip',
            diagnostics: ['pending-user-message']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'The pending user turn should be visible to Recursion.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'pending user message merge run skips safely');
  assert(view.lastSnapshot.messages.some((message) => message.text === 'The pending user turn should be visible to Recursion.'), 'runtime snapshot includes pending user turn');
  assert(!arbiterPrompt.includes('The pending user turn should be visible to Recursion.'), 'arbiter prompt excludes pending user turn text');
  assertEqual(view.lastSnapshot.latestMesId, 8, 'pending user turn advances latest message id');
}

{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: {
      chatId: 'pending-mesid-chat',
      chatKey: 'pending-mesid-chat',
      sceneKey: 'pending-mesid-scene',
      sceneFingerprint: 'pending-mesid-scene-fp',
      turnFingerprint: 'pending-mesid-old-turn-fp',
      latestMesId: 7,
      messages: [
        { mesid: 7, role: 'assistant', text: 'The previous assistant reply is committed.', visible: true }
      ]
    },
    generationRouter: {
      async generate(roleId, request) {
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'skip',
            diagnostics: ['pending-user-message-mesid']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({
    userMessage: { mesid: 12, text: 'The pending user turn carries its host mesid.' }
  });
  const view = runtime.view();
  const pendingMessage = view.lastSnapshot.messages.find((message) => message.text === 'The pending user turn carries its host mesid.');
  assertEqual(result.ok, true, 'pending user message object merge run skips safely');
  assertEqual(pendingMessage?.mesid, 12, 'pending user turn preserves host mesid');
  assertEqual(view.lastSnapshot.latestMesId, 12, 'pending user turn preserves host latest message id');
}

{
  let snapshotReads = 0;
  const pendingText = 'The committed pending turn should still install.';
  const initialSnapshot = {
    chatId: 'pending-install-chat',
    chatKey: 'pending-install-chat',
    sceneKey: 'pending-install-scene',
    sceneFingerprint: 'pending-install-scene-fp',
    turnFingerprint: 'pending-install-before-host-fp',
    latestMesId: 30,
    messages: [
      { mesid: 30, role: 'assistant', text: 'The prior assistant reply is committed.', visible: true }
    ]
  };
  const committedSnapshot = {
    ...initialSnapshot,
    turnFingerprint: 'host-committed-pending-fp',
    latestMesId: 31,
    messages: [
      ...initialSnapshot.messages,
      { mesid: 31, role: 'user', text: pendingText, visible: true }
    ]
  };
  const { runtime, calls, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => {
      snapshotReads += 1;
      return snapshotReads === 1 ? initialSnapshot : committedSnapshot;
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: { mesid: 31, text: pendingText } });
  assertEqual(result.ok, true, 'committed pending user turn is still fresh enough to install');
  assertEqual(result.skipped, undefined, 'committed pending user turn is not treated as stale');
  assertEqual(calls.snapshot, 3, 'committed pending install reads initial, compose, and install snapshots');
  assertEqual(installed.length, 1, 'committed pending user turn installs prompt');
  assert(JSON.stringify(installed[0]).includes(pendingText), 'installed prompt includes committed pending user turn');
}

{
  let snapshotReads = 0;
  const pendingText = 'The committed pending hard shift should still install.';
  const initialSnapshot = {
    chatId: 'pending-hard-shift-chat',
    chatKey: 'pending-hard-shift-chat',
    sceneKey: 'pending-hard-shift-scene',
    sceneFingerprint: 'pending-hard-shift-scene-fp',
    turnFingerprint: 'pending-hard-shift-before-host-fp',
    latestMesId: 40,
    messages: [
      { mesid: 40, role: 'assistant', text: 'The prior scene ends.', visible: true }
    ]
  };
  const committedSnapshot = {
    ...initialSnapshot,
    turnFingerprint: 'host-committed-pending-hard-shift-fp',
    latestMesId: 41,
    messages: [
      ...initialSnapshot.messages,
      { mesid: 41, role: 'user', text: pendingText, visible: true }
    ]
  };
  const { runtime, installed, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => {
      snapshotReads += 1;
      return snapshotReads === 1 ? initialSnapshot : committedSnapshot;
    },
    generationRouter: {
      async generate(roleId, request) {
        assertEqual(roleId, 'utilityArbiter', 'pending hard-shift install only needs Utility Arbiter');
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'compose-brief',
            sceneStatus: 'hard-shift',
            diagnostics: ['pending-hard-shift-commit']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: { mesid: 41, text: pendingText } });
  const expectedCommittedSceneFingerprint = hashJson({
    previousSceneFingerprint: committedSnapshot.sceneFingerprint,
    hardShiftAtMesId: committedSnapshot.latestMesId,
    turnFingerprint: committedSnapshot.turnFingerprint
  });
  const expectedCommittedSceneKey = `${committedSnapshot.chatKey}-${expectedCommittedSceneFingerprint}`;
  const view = runtime.view();
  assertEqual(result.ok, true, 'committed pending hard-shift turn is still fresh enough to install');
  assertEqual(result.skipped, undefined, 'committed pending hard-shift turn is not treated as stale');
  assertEqual(installed.length, 1, 'committed pending hard-shift turn installs prompt');
  assertEqual(view.lastSnapshot.sceneFingerprint, expectedCommittedSceneFingerprint, 'committed pending hard-shift snapshot becomes canonical');
  assertEqual(view.lastPacket.sceneFingerprint, expectedCommittedSceneFingerprint, 'committed pending hard-shift packet uses canonical scene fingerprint');
  const committedCache = await storage.loadSceneCache(committedSnapshot.chatKey, expectedCommittedSceneKey);
  assertEqual(committedCache.latestHand?.handId, view.lastHand.handId, 'committed pending hard-shift cache saves under canonical scene key');
}

{
  let snapshotReads = 0;
  const pendingText = 'The late committed hard shift should recompose before install.';
  const initialSnapshot = {
    chatId: 'late-hard-shift-chat',
    chatKey: 'late-hard-shift-chat',
    sceneKey: 'late-hard-shift-scene',
    sceneFingerprint: 'late-hard-shift-scene-fp',
    turnFingerprint: 'late-hard-shift-before-host-fp',
    latestMesId: 50,
    messages: [
      { mesid: 50, role: 'assistant', text: 'The old scene is still closing.', visible: true }
    ]
  };
  const committedSnapshot = {
    ...initialSnapshot,
    turnFingerprint: 'host-late-committed-hard-shift-fp',
    latestMesId: 51,
    messages: [
      ...initialSnapshot.messages,
      { mesid: 51, role: 'user', text: pendingText, visible: true }
    ]
  };
  const { runtime, installed, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => {
      snapshotReads += 1;
      return snapshotReads <= 2 ? initialSnapshot : committedSnapshot;
    },
    generationRouter: {
      async generate(roleId, request) {
        assertEqual(roleId, 'utilityArbiter', 'late pending hard-shift install only needs Utility Arbiter');
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'compose-brief',
            sceneStatus: 'hard-shift',
            diagnostics: ['late-pending-hard-shift-commit']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: { mesid: 51, text: pendingText } });
  const expectedCommittedSceneFingerprint = hashJson({
    previousSceneFingerprint: committedSnapshot.sceneFingerprint,
    hardShiftAtMesId: committedSnapshot.latestMesId,
    turnFingerprint: committedSnapshot.turnFingerprint
  });
  const expectedCommittedSceneKey = `${committedSnapshot.chatKey}-${expectedCommittedSceneFingerprint}`;
  const view = runtime.view();
  assertEqual(result.ok, true, 'late committed pending hard-shift turn still installs');
  assertEqual(installed.length, 1, 'late committed pending hard-shift turn installs one prompt');
  assertEqual(view.lastSnapshot.sceneFingerprint, expectedCommittedSceneFingerprint, 'late committed pending hard-shift snapshot becomes canonical');
  assertEqual(view.lastPacket.sceneFingerprint, expectedCommittedSceneFingerprint, 'late committed pending hard-shift packet is recomposed with canonical scene fingerprint');
  const committedCache = await storage.loadSceneCache(committedSnapshot.chatKey, expectedCommittedSceneKey);
  assertEqual(committedCache.latestHand?.handId, view.lastHand.handId, 'late committed pending hard-shift cache saves under canonical scene key');
}

{
  let snapshotReads = 0;
  const pendingText = 'The final moved hard shift must not install.';
  const initialSnapshot = {
    chatId: 'final-move-chat',
    chatKey: 'final-move-chat',
    sceneKey: 'final-move-scene',
    sceneFingerprint: 'final-move-scene-fp',
    turnFingerprint: 'final-move-before-host-fp',
    latestMesId: 60,
    messages: [
      { mesid: 60, role: 'assistant', text: 'The old scene waits.', visible: true }
    ]
  };
  const committedSnapshot = {
    ...initialSnapshot,
    turnFingerprint: 'host-final-move-committed-fp',
    latestMesId: 61,
    messages: [
      ...initialSnapshot.messages,
      { mesid: 61, role: 'user', text: pendingText, visible: true }
    ]
  };
  const movedSnapshot = {
    ...committedSnapshot,
    turnFingerprint: 'host-final-move-after-recompose-fp',
    latestMesId: 62,
    messages: [
      ...committedSnapshot.messages,
      { mesid: 62, role: 'assistant', text: 'The host moved again before install.', visible: true }
    ]
  };
  const { runtime, calls, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => {
      snapshotReads += 1;
      if (snapshotReads <= 2) return initialSnapshot;
      if (snapshotReads === 3) return committedSnapshot;
      return movedSnapshot;
    },
    generationRouter: {
      async generate(roleId, request) {
        assertEqual(roleId, 'utilityArbiter', 'final move hard-shift install only needs Utility Arbiter');
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'compose-brief',
            sceneStatus: 'hard-shift',
            diagnostics: ['final-move-after-recompose']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: { mesid: 61, text: pendingText } });
  assertEqual(result.ok, true, 'final moved hard-shift skip is nonfatal');
  assertEqual(result.skipped, true, 'final moved hard-shift skips prompt install');
  assertEqual(result.reason, 'stale-snapshot', 'final moved hard-shift reports stale snapshot');
  assertEqual(calls.snapshot, 4, 'final moved hard-shift rechecks after recompose');
  assertEqual(calls.install, 0, 'final moved hard-shift does not call host prompt install');
  assertEqual(installed.length, 0, 'final moved hard-shift does not write prompt packet');
}

{
  let snapshotReads = 0;
  const unchangedPrefix = 'A'.repeat(950);
  const initialText = `${unchangedPrefix} old visible ending`;
  const editedText = `${unchangedPrefix} new visible ending`;
  const initialSnapshot = {
    chatId: 'long-edit-chat',
    chatKey: 'long-edit-chat',
    sceneKey: 'long-edit-scene',
    sceneFingerprint: 'long-edit-scene-fp',
    turnFingerprint: 'long-edit-before-fp',
    latestMesId: 70,
    messages: [
      { mesid: 70, role: 'user', text: initialText, visible: true }
    ]
  };
  const editedSnapshot = {
    ...initialSnapshot,
    turnFingerprint: 'long-edit-after-fp',
    messages: [
      { mesid: 70, role: 'user', text: editedText, visible: true }
    ]
  };
  const { runtime, calls, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => {
      snapshotReads += 1;
      return snapshotReads === 1 ? initialSnapshot : editedSnapshot;
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: initialText });
  assertEqual(result.ok, true, 'long visible edit skip is nonfatal');
  assertEqual(result.skipped, true, 'long visible edit skips prompt install');
  assertEqual(result.reason, 'stale-snapshot', 'long visible edit reports stale snapshot');
  assertEqual(calls.install, 0, 'long visible edit does not call host prompt install');
  assertEqual(installed.length, 0, 'long visible edit does not write prompt packet');
}

{
  let snapshotReads = 0;
  const unchangedPrefix = 'B'.repeat(1300);
  const initialText = `${unchangedPrefix} old beyond runtime cap`;
  const editedText = `${unchangedPrefix} new beyond runtime cap`;
  const initialSnapshot = {
    chatId: 'runtime-cap-edit-chat',
    chatKey: 'runtime-cap-edit-chat',
    sceneKey: 'runtime-cap-edit-scene',
    sceneFingerprint: 'runtime-cap-edit-scene-fp',
    turnFingerprint: 'runtime-cap-edit-before-fp',
    latestMesId: 75,
    messages: [
      { mesid: 75, role: 'user', text: initialText, visible: true }
    ]
  };
  const editedSnapshot = {
    ...initialSnapshot,
    turnFingerprint: 'runtime-cap-edit-after-fp',
    messages: [
      { mesid: 75, role: 'user', text: editedText, visible: true }
    ]
  };
  const { runtime, calls, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => {
      snapshotReads += 1;
      return snapshotReads === 1 ? initialSnapshot : editedSnapshot;
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: initialText });
  assertEqual(result.ok, true, 'runtime-cap visible edit skip is nonfatal');
  assertEqual(result.skipped, true, 'runtime-cap visible edit skips prompt install');
  assertEqual(result.reason, 'stale-snapshot', 'runtime-cap visible edit reports stale snapshot');
  assertEqual(calls.install, 0, 'runtime-cap visible edit does not call host prompt install');
  assertEqual(installed.length, 0, 'runtime-cap visible edit does not write prompt packet');
}

{
  let snapshotReads = 0;
  const visibleText = 'Visible turn is unchanged while hidden host state advances.';
  const initialSnapshot = {
    chatId: 'hidden-bookkeeping-chat',
    chatKey: 'hidden-bookkeeping-chat',
    sceneKey: 'hidden-bookkeeping-scene',
    sceneFingerprint: 'hidden-bookkeeping-scene-fp',
    turnFingerprint: 'hidden-bookkeeping-before-fp',
    latestMesId: 80,
    messages: [
      { mesid: 80, role: 'user', text: visibleText, visible: true }
    ]
  };
  const hiddenAdvancedSnapshot = {
    ...initialSnapshot,
    turnFingerprint: 'hidden-bookkeeping-after-fp',
    latestMesId: 81,
    messages: [
      ...initialSnapshot.messages,
      { mesid: 81, role: 'assistant', text: 'Hidden bookkeeping update.', visible: false }
    ]
  };
  const { runtime, calls, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => {
      snapshotReads += 1;
      return snapshotReads === 1 ? initialSnapshot : hiddenAdvancedSnapshot;
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: visibleText });
  assertEqual(result.ok, true, 'hidden host bookkeeping still installs');
  assertEqual(result.skipped, undefined, 'hidden host bookkeeping is not treated as stale');
  assertEqual(calls.snapshot, 3, 'hidden host bookkeeping uses normal install recheck cadence');
  assertEqual(calls.install, 1, 'hidden host bookkeeping calls host prompt install');
  assertEqual(installed.length, 1, 'hidden host bookkeeping writes one prompt packet');
}

{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: {
      chatId: 'repeat-pending-chat',
      chatKey: 'repeat-pending-chat',
      sceneKey: 'repeat-pending-scene',
      sceneFingerprint: 'repeat-pending-scene-fp',
      turnFingerprint: 'repeat-pending-old-turn-fp',
      latestMesId: 4,
      messages: [
        { mesid: 3, role: 'user', text: 'Repeat this.', visible: true },
        { mesid: 4, role: 'assistant', text: 'The assistant answered the first repeat.', visible: true }
      ]
    },
    generationRouter: {
      async generate(roleId, request) {
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'skip',
            diagnostics: ['repeated-pending-user-message']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Repeat this.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'repeated pending user text run skips safely');
  assertEqual(view.lastSnapshot.messages.filter((message) => message.role === 'user' && message.text === 'Repeat this.').length, 2, 'repeated pending user text is appended after an assistant reply');
  assertEqual(view.lastSnapshot.latestMesId, 5, 'repeated pending user turn advances latest message id');
}

{
  const arbiterPrompts = [];
  const { runtime } = createRuntimeHarness({
    settings: {
      mode: 'auto',
      strength: 'strong',
      focus: 'character',
      reasoningLevel: 'medium',
      promptFootprint: 'normal',
      reasonerUse: 'auto',
      providers: {
        utility: { enabled: true, source: 'host-current-model', lastTest: { status: 'fail', checkedAt: '2026-06-30T00:00:00.000Z', compactError: 'Bearer settings-token sk-live-settings private-secret' } },
        reasoner: { enabled: true, source: 'openai-compatible', openAICompatible: { apiKey: 'sk-settings-key' }, lastTest: { status: 'pass', compactError: 'Bearer reasoner-settings' } }
      }
    },
    generationRouter: {
      async generate(roleId, request) {
        if (roleId === 'utilityArbiter') arbiterPrompts.push(request.prompt);
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'skip',
            diagnostics: ['settings-projection']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Settings projection.' });
  assertEqual(result.ok, true, 'settings projection run skips safely');
  assertEqual(arbiterPrompts.length, 1, 'arbiter prompt captured');
  assert(arbiterPrompts[0].includes('"mode":"auto"'), 'arbiter prompt includes planning mode');
  assert(arbiterPrompts[0].includes('"reasoningLevel":"medium"'), 'arbiter prompt includes reasoning level');
  assert(arbiterPrompts[0].includes('"promptFootprint":"normal"'), 'arbiter prompt includes prompt footprint');
  assert(arbiterPrompts[0].includes('Behavior policy:'), 'arbiter prompt includes behavior policy header');
  assert(arbiterPrompts[0].includes('Strength: Strong.'), 'arbiter prompt includes strength policy');
  assert(arbiterPrompts[0].includes('Focus: Character.'), 'arbiter prompt includes focus policy');
  assert(arbiterPrompts[0].includes('Prompt Footprint: Normal.'), 'arbiter prompt includes footprint policy');
  assert(arbiterPrompts[0].includes('Card job contract:'), 'Arbiter prompt includes card job contract');
  assert(
    arbiterPrompts[0].includes('To create or refresh a card, emit a cardJobs entry.'),
    'Arbiter prompt explains create/refresh card job requirement'
  );
  assert(
    arbiterPrompts[0].includes('Lifecycle regenerate marks an old cached card stale; it does not create a replacement without cardJobs.'),
    'Arbiter prompt explains regenerate without replacement behavior'
  );
  const arbiterPromptSnapshotHash = /^Snapshot hash: (.+)$/m.exec(arbiterPrompts[0])?.[1]?.trim();
  assert(arbiterPromptSnapshotHash, 'Arbiter prompt includes snapshot hash line');
  assert(
    arbiterPrompts[0].includes(`"schema": "${UTILITY_ARBITER_SCHEMA}"`),
    'Arbiter prompt spells out required schema field'
  );
  assert(
    arbiterPrompts[0].includes(`"snapshotHash": "${arbiterPromptSnapshotHash}"`),
    'Arbiter prompt spells out required snapshot hash field'
  );
  assert(
    arbiterPrompts[0].includes('Do not emit reasoning, lifecycleActions, markdown, or prose.'),
    'Arbiter prompt forbids common invalid alternate fields'
  );
  assert(!arbiterPrompts[0].includes('lastTest'), 'arbiter prompt omits provider test diagnostics');
  assert(!arbiterPrompts[0].includes('openAICompatible'), 'arbiter prompt omits endpoint settings');
  assert(!arbiterPrompts[0].includes('compactError'), 'arbiter prompt omits provider compact errors');
  assert(!arbiterPrompts[0].includes('checkedAt'), 'arbiter prompt omits provider test timestamps');
  const providerHealth = parsePromptJsonSection(arbiterPrompts[0], 'Provider health');
  assertDeepEqual(providerHealth, {
    utility: { enabled: true, source: 'host-current-model', status: 'fail' },
    reasoner: { enabled: true, source: 'openai-compatible', status: 'pass' }
  }, 'arbiter provider health prompt exposes only lane, source, and status');
  assertNoSecretText(arbiterPrompts[0], 'arbiter settings prompt');
  assertNoSecretText(runtime.view().settings, 'runtime view settings');
  assertEqual(runtime.view().settings.reasoningLevel, 'medium', 'runtime view keeps reasoning level');
  assertEqual(runtime.view().settings.providers.utility.enabled, true, 'view keeps utility provider enabled flag');
  assertEqual(runtime.view().settings.providers.utility.source, 'host-current-model', 'view keeps utility provider source');
  assertDeepEqual(
    runtime.view().settings.providers.reasoner.openAICompatible,
    { baseUrl: '', model: '', sessionApiKeyPresent: false },
    'view keeps safe endpoint settings without secrets'
  );
}

{
  const arbiterPrompts = [];
  const guidancePrompts = [];
  const cardPrompts = [];
  const storySnapshot = {
    chatId: 'story-form-chat',
    chatKey: 'story-form-chat',
    sceneKey: 'story-form-scene',
    sceneFingerprint: 'story-form-scene',
    turnFingerprint: 'story-form-turn',
    latestMesId: 3,
    messages: [
      { mesid: 1, role: 'user', text: 'I open the hatch.', visible: true },
      { mesid: 2, role: 'assistant', text: 'Mara stepped through the hatch and kept her hand on the rail.', visible: true },
      { mesid: 3, role: 'user', text: 'I ask what she sees.', visible: true }
    ]
  };
  const { runtime } = createRuntimeHarness({
    snapshot: storySnapshot,
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request = {}) {
        if (roleId === 'utilityArbiter') {
          arbiterPrompts.push(request.prompt);
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'refresh-cards',
              sceneStatus: 'same-scene',
              promptFootprint: 'normal',
              storyForm: {
                schema: 'recursion.storyForm.v1',
                tense: 'past',
                pov: 'third-person-limited',
                confidence: 'high',
                evidenceRefs: ['message:2'],
                reason: 'Latest assistant narration is past-tense third person.'
              },
              cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Check story form.' }],
              reasonerDecision: { mode: 'skip', reason: 'unit story form', signals: [] },
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              diagnostics: ['story-form-arbiter']
            }
          };
        }
        if (roleId === 'sceneFrameCard') {
          cardPrompts.push(request.prompt);
          return cardProviderResponse(roleId, request);
        }
        if (roleId === 'guidanceComposer') {
          guidancePrompts.push(request.prompt);
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'Keep the response in past tense third-person limited form.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['story-form-guidance']
            }
          };
        }
        throw new Error(`unexpected role ${roleId}`);
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'I ask what she sees.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'story form run installs');
  assert(arbiterPrompts[0].includes('latest visible assistant narration first'), 'Arbiter prompt includes assistant-first story form rule');
  assert(arbiterPrompts[0].includes('"storyForm"'), 'Arbiter output contract requires storyForm');
  assertDeepEqual(result.plan.storyForm, {
    schema: 'recursion.storyForm.v1',
    tense: 'past',
    pov: 'third-person-limited',
    confidence: 'high',
    evidenceRefs: ['message:2'],
    reason: 'Latest assistant narration is past-tense third person.'
  }, 'valid Arbiter story form enters plan');
  assert(cardPrompts[0].includes('Target tense: past.'), 'card prompt receives story tense');
  assert(cardPrompts[0].includes('Target POV: third-person-limited.'), 'card prompt receives story pov');
  assert(guidancePrompts[0].includes('past tense, third-person-limited POV'), 'guidance composer receives story form');
  assertEqual(view.lastPacket.storyForm.tense, 'past', 'packet stores story tense');
  assertEqual(view.lastPacket.storyForm.pov, 'third-person-limited', 'packet stores story pov');
  assert(view.lastPacket.sections.guidance.includes('past tense, third-person-limited POV'), 'installed guidance names story form');
}

{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'compose-brief',
            sceneStatus: 'same-scene',
            cardJobs: [{
              family: 'Open Threads',
              reason: 'Bearer plan-token, sk-live-card, and private-secret must be scrubbed.',
              extraJobField: 'sk-extra-job'
            }],
            budgets: { targetBriefTokens: 500, maxCards: 1 },
            reasonerDecision: {
              mode: 'skip',
              reason: 'Bearer reasoner-token, sk-live-reasoner, and private-secret must be scrubbed.',
              signals: ['safe-signal', 'Bearer signal-token', 'sk-live-signal', { nested: 'private-secret' }],
              extraDecisionField: 'sk-extra-decision'
            },
            diagnostics: [
              'safe-diagnostic',
              'Bearer diagnostic-token',
              'sk-live-diagnostic',
              'private-secret',
              { code: 'object-diagnostic', message: 'structured provider diagnostic' }
            ],
            apiKey: 'sk-extra-top-level',
            authorization: 'Bearer extra-top-level',
            nested: { secret: 'private-secret' }
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Scrub plan.' });
  const viewPlan = runtime.view().lastPlan;
  assertEqual(result.ok, true, 'scrubbed arbiter plan still installs');
  assertEqual(result.plan.apiKey, undefined, 'result plan drops arbitrary top-level apiKey');
  assertEqual(result.plan.authorization, undefined, 'result plan drops arbitrary top-level authorization');
  assertEqual(result.plan.nested, undefined, 'result plan drops arbitrary top-level nested object');
  assertEqual(result.plan.cardJobs[0].extraJobField, undefined, 'result plan drops arbitrary card job fields');
  assertEqual(result.plan.reasonerDecision.extraDecisionField, undefined, 'result plan drops arbitrary reasoner decision fields');
  assertDeepEqual(Object.keys(result.plan).sort(), ['action', 'budgets', 'cardJobs', 'diagnostics', 'lifecycle', 'promptFootprint', 'reasonerDecision', 'sceneStatus', 'schema', 'snapshotHash', 'source', 'storyForm'].sort(), 'result plan only exposes whitelisted fields');
  assert(result.plan.diagnostics.includes('safe-diagnostic'), 'safe diagnostics survive plan scrub');
  assertNoObjectString(result.plan.diagnostics, 'object-valued arbiter diagnostics do not stringify to object marker');
  assert(result.plan.reasonerDecision.signals.includes('safe-signal'), 'safe reasoner signals survive plan scrub');
  assert(result.plan.reasonerDecision.signals.every((signal) => typeof signal === 'string'), 'reasoner signals normalize to strings');
  assertNoSecretText({ resultPlan: result.plan, viewPlan }, 'successful arbiter plan');
}

for (const scenario of [
  { label: 'mismatched', snapshotHash: 'hallucinated-provider-hash' },
  { label: 'missing', snapshotHash: undefined }
]) {
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              ...(scenario.snapshotHash === undefined ? {} : { snapshotHash: scenario.snapshotHash }),
              action: 'refresh-cards',
              cardJobs: [{ role: 'openThreadsCard', priority: 0.9, reason: 'stale plan card job' }],
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              diagnostics: [`${scenario.label}-snapshot-hash`]
            }
          };
        }
        return {
          ok: true,
          roleId,
          data: {
            schema: 'recursion.card.v1',
            snapshotHash: request.snapshotHash,
            role: 'openThreadsCard',
            family: 'Open Threads',
            items: [{ id: 'stale-card', promptText: 'This stale card job should not run.', evidenceRefs: ['message:1'] }]
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: `Reject ${scenario.label} Arbiter hash.` });
  assertEqual(result.ok, true, `${scenario.label} arbiter snapshot hash falls back fail-soft`);
  assertDeepEqual(routerCalls, ['utilityArbiter', 'guidanceComposer'], `${scenario.label} arbiter snapshot hash only launches guidance after fallback`);
  assertEqual(result.plan.action, 'compose-brief', `${scenario.label} arbiter snapshot hash uses local fallback plan`);
  assertEqual(result.plan.cardJobs.length, 0, `${scenario.label} arbiter snapshot hash drops provider card jobs`);
  assert(result.plan.diagnostics.includes('utility-arbiter-fallback'), `${scenario.label} arbiter snapshot hash records fallback diagnostic`);
  assert(!result.plan.diagnostics.includes(`${scenario.label}-snapshot-hash`), `${scenario.label} arbiter diagnostics are not trusted`);
  assert(result.plan.snapshotHash !== scenario.snapshotHash, `${scenario.label} provider snapshot hash is rejected`);
  assertEqual(result.plan.snapshotHash, result.plan.source.snapshotHash, `${scenario.label} fallback snapshot hash remains authoritative`);
  assertEqual(runtime.view().lastPlan.snapshotHash, result.plan.snapshotHash, `${scenario.label} view plan uses runtime snapshot hash`);
}

{
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            budgets: { targetBriefTokens: 0, maxCards: 0 },
            diagnostics: ['zero-budget']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Zero budget.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'zero-budget plan still runs fail-soft');
  assertEqual(installed.length, 1, 'zero-budget plan still installs compact packet');
  assertEqual(view.lastPlan.budgets.maxCards, 0, 'zero maxCards budget is preserved');
  assertEqual(view.lastPlan.budgets.targetBriefTokens, 0, 'zero token budget is preserved');
  assertEqual(view.lastHand.cards.length, 0, 'zero maxCards budget selects no cards');
}

{
  const longProviderCardText = `Provider long card start ${'scene pressure '.repeat(240)}LAST-BRIEF-RUNTIME-END`;
  const { runtime, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            cardJobs: [{ family: 'Open Threads', reason: 'Need a provider provenance card.' }],
            budgets: { targetBriefTokens: 900, maxCards: 6 }
          }
        };
      },
      async batch(requests) {
        return requests.map((request) => ({
          ok: true,
          roleId: request.roleId,
          data: {
            schema: 'recursion.card.v1',
            role: request.metadata.role,
            family: request.metadata.family,
            snapshotHash: request.snapshotHash,
            items: [{
              snapshotHash: 'hallucinated-card-snapshot-hash',
              source: { snapshotHash: 'hallucinated-source-snapshot-hash' },
              freshness: { sourceFingerprint: 'hallucinated-freshness-hash' },
              promptText: longProviderCardText,
              evidenceRefs: ['message:2'],
              tokenEstimate: 12
            }]
          }
        }));
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Provider provenance.' });
  const view = runtime.view();
  const cache = await storage.loadSceneCache(view.lastSnapshot.chatKey, view.lastSnapshot.sceneKey);
  const providerCard = cache.cards.find((card) => card.promptText.includes('Provider long card start'));
  const handCard = view.lastHand.cards.find((card) => card.promptText.includes('Provider long card start'));
  const expectedProviderSourceHash = sourceWindowHash([
    { mesid: 2, role: 'user', text: 'The lamp breaks.', visible: true },
    { mesid: 3, role: 'user', text: 'Provider provenance.', visible: true }
  ], 2, 3);
  assertEqual(result.ok, true, 'provider card provenance run installs');
  assert(handCard, 'provider card is selected into full hand');
  assertEqual(handCard.promptText, longProviderCardText, 'runtime view preserves full selected card text for expanded Last Brief rows');
  assert(handCard.promptText.endsWith('LAST-BRIEF-RUNTIME-END'), 'runtime view card text is not clipped with ellipsis');
  assertEqual(providerCard?.promptText, longProviderCardText, 'scene cache preserves full card text before prompt-packet budgeting');
  assertEqual(handCard.source?.snapshotHash, undefined, 'hand card exposes compact prompt-safe shape only');
  assert(providerCard, 'provider card is persisted to cache');
  assertEqual(providerCard.sourceFingerprint, expectedProviderSourceHash, 'provider card cache fingerprint uses runtime source-window hash');
  assert(!JSON.stringify({ view, cache }).includes('hallucinated-card-snapshot-hash'), 'provider card top-level snapshot hash is ignored everywhere visible');
  assert(!JSON.stringify({ view, cache }).includes('hallucinated-source-snapshot-hash'), 'provider card source snapshot hash is ignored everywhere visible');
  assert(!JSON.stringify({ view, cache }).includes('hallucinated-freshness-hash'), 'provider card freshness fingerprint is ignored everywhere visible');
}

{
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'skip',
            diagnostics: ['arbiter-skip-test'],
            budgets: { targetBriefTokens: 500, maxCards: 4 }
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Arbiter says skip.' });
  assertEqual(result.ok, true, 'arbiter skip returns ok');
  assertEqual(result.skipped, true, 'arbiter skip result is marked skipped');
  assertEqual(result.reason, 'arbiter-skip', 'arbiter skip reason is explicit');
  assertEqual(installed.length, 0, 'arbiter skip does not install prompt');
  assertEqual(runtime.view().activity.label, 'Recursion skipped by Utility Arbiter.', 'arbiter skip settles visible activity');
}

{
  const { runtime, installed, calls } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    hostPrompt: { methods: { clear: undefined } },
    generationRouter: {
      async generate(roleId, request) {
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'skip',
            diagnostics: ['arbiter-skip-missing-clear']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Arbiter skip missing clear.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'arbiter skip still returns skipped when clear API is missing');
  assertEqual(result.skipped, true, 'arbiter skip missing clear result is marked skipped');
  assertEqual(result.clear.ok, false, 'arbiter skip missing clear returns non-ok clear outcome');
  assertEqual(result.clear.error.code, 'RECURSION_PROMPT_CLEAR_UNAVAILABLE', 'arbiter skip missing clear returns explicit error code');
  assertEqual(calls.clear, 0, 'arbiter skip missing clear does not call host clear');
  assertEqual(installed.length, 0, 'arbiter skip missing clear does not install prompt');
  assertEqual(view.activity.severity, 'warning', 'arbiter skip missing clear surfaces warning activity');
  assert(view.activity.label.includes('Prompt clear failed'), 'arbiter skip missing clear has visible warning label');
}

{
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: healthyReasonerSettings({ mode: 'auto', promptFootprint: 'normal', reasonerUse: 'auto' }),
    generationRouter: {
      async generate(roleId, request = {}) {
        routerCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              reasonerDecision: { mode: 'use', reason: 'crowded hand', signals: ['test'] },
              budgets: { targetBriefTokens: 900, maxCards: 6 }
            }
          };
        }
        if (roleId === 'reasonerComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.reasonerComposer.v1',
              snapshotHash: parseReasonerPromptSnapshotHash(request.prompt),
              instructionPatch: 'Use the compact synthesis.',
              keptCardIds: [],
              droppedCardIds: []
            }
          };
        }
        throw new Error(`unexpected role ${roleId}`);
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Use reasoner when arbiter asks.' });
  assertEqual(result.ok, true, 'arbiter reasoner decision still installs');
  assert(routerCalls.includes('reasonerComposer'), 'arbiter reasoner use promotes reasoner composer when setting is auto');
  assertEqual(runtime.view().lastPacket.diagnostics.reasonerStatus, 'used', 'reasoner status records arbiter-promoted reasoner');
}

{
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', promptFootprint: 'rich', reasonerUse: 'auto' },
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              reasonerDecision: { mode: 'skip', reason: 'rich prompt does not need reasoner', signals: ['explicit-skip'] },
              budgets: { targetBriefTokens: 900, maxCards: 6 }
            }
          };
        }
        if (roleId === 'reasonerComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.reasonerComposer.v1',
              instructionPatch: 'This should not be used.',
              keptCardIds: [],
              droppedCardIds: []
            }
          };
        }
        throw new Error(`unexpected role ${roleId}`);
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Skip reasoner on rich auto.' });
  assertEqual(result.ok, true, 'rich auto run still installs when arbiter skips reasoner');
  assert(!routerCalls.includes('reasonerComposer'), 'arbiter reasoner skip suppresses reasoner composer for rich auto prompts');
  assertEqual(runtime.view().lastPacket.diagnostics.reasonerStatus, 'skipped', 'reasoner status stays skipped when arbiter skips reasoner');
}

{
  let arbiterSignal = null;
  let batchSignal = null;
  let reasonerSignal = null;
  let arbiterRequestSnapshotHash = null;
  let reasonerRequestSnapshotHash = null;
  const { runtime } = createRuntimeHarness({
    settings: healthyReasonerSettings({ mode: 'auto', promptFootprint: 'rich', reasonerUse: 'always' }),
    generationRouter: {
      async generate(roleId, request = {}) {
        if (roleId === 'utilityArbiter') {
          arbiterSignal = request.signal;
          arbiterRequestSnapshotHash = request.snapshotHash;
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              cardJobs: [{ family: 'Open Threads', reason: 'Need one open thread card.' }],
              budgets: { targetBriefTokens: 900, maxCards: 6 },
              reasonerDecision: { mode: 'use', reason: 'signal propagation test', signals: ['signal-test'] }
            }
          };
        }
        if (roleId === 'reasonerComposer') {
          reasonerSignal = request.signal;
          reasonerRequestSnapshotHash = request.snapshotHash;
          return {
            ok: true,
            data: {
              schema: 'recursion.reasonerComposer.v1',
              snapshotHash: parseReasonerPromptSnapshotHash(request.prompt),
              instructionPatch: 'Keep the signal-threaded guidance.',
              keptCardIds: [],
              droppedCardIds: []
            }
          };
        }
        throw new Error(`unexpected role ${roleId}`);
      },
      async batch(requests, options = {}) {
        batchSignal = options.signal;
        return requests.map((request) => ({
          ok: true,
          roleId: request.roleId,
          data: {
            schema: 'recursion.card.v1',
            role: request.metadata.role,
            family: request.metadata.family,
            snapshotHash: request.snapshotHash,
            items: [{
              promptText: 'Remember the signal-threaded open thread.',
              evidenceRefs: ['message:2'],
              tokenEstimate: 10
            }]
          }
        }));
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Thread abort signals.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'signal-threaded provider run still installs');
  assertEqual(arbiterRequestSnapshotHash, result.plan.snapshotHash, 'utility arbiter request includes frozen plan snapshot hash');
  assertEqual(reasonerRequestSnapshotHash, view.lastPacket.snapshotHash, 'reasoner composer request includes prompt packet snapshot hash');
  assert(isAbortSignal(arbiterSignal), 'utility arbiter receives per-run abort signal');
  assert(isAbortSignal(batchSignal), 'card batch receives per-run abort signal');
  assert(isAbortSignal(reasonerSignal), 'reasoner composer receives per-run abort signal through prompt composition');
  assertEqual(arbiterSignal, batchSignal, 'utility arbiter and batch share the run signal');
  assertEqual(arbiterSignal, reasonerSignal, 'reasoner composer shares the run signal');
}

{
  const activity = createActivityReporter();
  const router = createGenerationRouter({
    activity,
    client: {
      async generate(roleId, request) {
        assertEqual(roleId, 'utilityArbiter', 'shared activity test only needs utility arbiter');
        return {
          text: JSON.stringify({
            schema: 'recursion.utilityArbiter.v1',
            action: 'compose-brief',
            cardJobs: [],
            budgets: { targetBriefTokens: 500, maxCards: 4 },
            reasonerDecision: { mode: 'skip', reason: 'shared activity test' }
          }),
          providerSource: 'test-client',
          providerId: 'test-client',
          model: 'test-model'
        };
      }
    }
  });
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    activity,
    generationRouter: router
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Shared activity.' });
  assertEqual(result.ok, true, 'shared activity router run installs');
  assertEqual(runtime.view().activity.label, 'Recursion prompt ready.', 'runtime prompt readiness owns final activity status');
}

{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        throw new Error('arbiter failed with Bearer arbiter-token, sk-arbiter-runtime, and private-secret');
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Arbiter secret fallback.' });
  const serialized = JSON.stringify({ result, view: runtime.view() });
  assertEqual(result.ok, true, 'secret-bearing arbiter error fails soft');
  assertEqual(result.skipped, true, 'secret-bearing arbiter error skips injection');
  assert(serialized.includes('utility-unavailable'), 'arbiter unavailable diagnostic retained');
  assert(!serialized.includes('Bearer arbiter-token'), 'arbiter fallback reason redacts bearer token');
  assert(!serialized.includes('sk-arbiter-runtime'), 'arbiter fallback reason redacts sk token');
  assert(!serialized.includes('private-secret'), 'arbiter fallback reason redacts private secret');
}

{
  const routerCalls = [];
  const { runtime, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push(roleId);
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            cardJobs: [{ role: 'openThreadsCard', reason: 'Need one open thread card.' }],
            budgets: { targetBriefTokens: 500, maxCards: 6 },
            diagnostics: ['provider-card-plan']
          }
        };
      },
      async batch(requests) {
        routerCalls.push(...requests.map((request) => request.roleId));
        return requests.map((request) => ({
          ok: true,
          roleId: request.roleId,
          data: {
            schema: 'recursion.card.v1',
            role: request.metadata.role,
            family: request.metadata.family,
            snapshotHash: request.snapshotHash,
            items: [{
              promptText: 'The unanswered signal still needs a response without Bearer live-token or sk-live-runtime.',
              summary: 'Open thread summary with Bearer live-token.',
              evidenceRefs: ['message:2 sk-live-runtime'],
              inspectorNotes: 'Diagnostic with Bearer live-token.',
              tokenEstimate: 18
            }]
          }
        }));
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Generate card job.' });
  const view = runtime.view();
  const cache = await storage.loadSceneCache(view.lastSnapshot.chatKey, view.lastSnapshot.sceneKey);
  assertEqual(result.ok, true, 'provider card job run installs prompt');
  assert(routerCalls.includes('utilityArbiter'), 'arbiter called for provider card job');
  assert(routerCalls.includes('openThreadsCard'), 'card job routed through batch');
  assert(cache.cards.some((card) => card.family === 'Open Threads'), 'provider card persisted in scene cache');
  assert(view.lastHand.cards.some((card) => card.family === 'Open Threads'), 'provider card selected into hand');
  assert(
    view.activityHistory.some((event) => event.phase === 'cardProgress'
      && event.detail?.parentStepId === 'utility-card-batch'
      && event.detail?.roleId === 'openThreadsCard'
      && event.detail?.source === 'generated'
      && event.detail?.state === 'done'),
    'provider-generated card emits generated child progress'
  );
  assert(view.lastPacket.sections.cardEvidence.includes('unanswered signal'), 'provider card reaches prompt packet');
  assert(!cache.cards.some((card) => card.family === 'Scene Frame'), 'successful provider card pass does not add local Scene Frame fallback card');
  assert(!cache.cards.some((card) => card.family === 'Scene Constraints'), 'successful provider card pass does not add local Scene Constraints fallback card');
  const serialized = JSON.stringify({ cache, hand: view.lastHand, packet: view.lastPacket });
  assert(!serialized.includes('Bearer live-token'), 'provider card bearer token redacted before persistence and prompt');
  assert(!serialized.includes('sk-live-runtime'), 'provider card sk token redacted before persistence and prompt');
}

{
  const roleCalls = [];
  let fusedRequest = null;
  let fusedStarted = false;
  let releaseFused;
  const fusedGate = new Promise((resolve) => { releaseFused = resolve; });
  const { runtime } = createRuntimeHarness({
    settings: healthyReasonerSettings({ pipelineMode: 'fused', mode: 'auto', reasoningLevel: 'high' }),
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              sceneStatus: 'same-scene',
              promptFootprint: 'normal',
              storyForm: {
                schema: 'recursion.storyForm.v1',
                tense: 'past',
                pov: 'third-person-limited',
                confidence: 'high',
                evidenceRefs: ['message:2'],
                reason: 'Assistant narration.'
              },
              cardJobs: [
                { family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Frame the scene.' },
                { family: 'Scene Constraints', role: 'sceneConstraintsCard', reason: 'Keep the door blocked.' }
              ],
              reasonerDecision: { mode: 'skip', reason: 'unit fused', signals: [] },
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              diagnostics: ['fused-runtime-plan']
            }
          };
        }
        if (roleId === 'fusedCardBundle') {
          fusedStarted = true;
          fusedRequest = request;
          await fusedGate;
          return {
            ok: true,
            roleId,
            lane: request.lane,
            diagnostics: { runId: 'fused-runtime-bundle' },
            data: {
              schema: 'recursion.cardBundle.v1',
              snapshotHash: request.snapshotHash,
              items: [
                {
                  schema: 'recursion.card.v1',
                  family: 'Scene Frame',
                  role: 'sceneFrameCard',
                  promptText: 'FUSED_RUNTIME_SCENE_FRAME: The doorway remained blocked.',
                  evidenceRefs: ['message:2'],
                  tokenEstimate: 18
                },
                {
                  schema: 'recursion.card.v1',
                  family: 'Scene Constraints',
                  role: 'sceneConstraintsCard',
                  promptText: 'FUSED_RUNTIME_CONSTRAINT: Do not open the sealed door casually.',
                  evidenceRefs: ['message:2'],
                  tokenEstimate: 19
                }
              ]
            }
          };
        }
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'Use fused cards.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['fused-guidance']
            }
          };
        }
        if (roleId === 'reasonerComposer') return reasonerComposerResponse(request, 'Fused reasoning synthesis.');
        throw new Error(`unexpected Fused role ${roleId}`);
      },
      async batch() {
        throw new Error('Fused pipeline should not run the Standard card batch path');
      }
    }
  });
  const pending = runtime.prepareForGeneration({ userMessage: 'Generate fused cards.' });
  await waitUntil(() => fusedStarted, 'Fused runtime did not enter the bundle call');
  const pendingView = runtime.view();
  const pendingProgress = createProgressRunModel(pendingView);
  const pendingBundle = pendingProgress.steps.find((step) => step.id === 'fused-card-bundle');
  assert(['fusedCardBundleRunning', 'providerCallRunning'].includes(pendingView.activity.phase), 'Fused runtime keeps foreground provider activity while bundle is pending');
  assertEqual(pendingBundle?.state, 'running', 'Fused bundle remains running during the provider wait');
  assert(createHeroPixelBlocks(pendingProgress).some((block) => block.id === 'fused-card-bundle' && block.state === 'running'), 'Fused waiting exposes a running hero pixel during the provider wait');
  releaseFused();
  const result = await pending;
  assertEqual(result.ok, true, 'Fused runtime installs prompt');
  assertEqual(roleCalls.filter((roleId) => roleId === 'fusedCardBundle').length, 1, 'Fused runtime makes one bundle card call');
  assert(!roleCalls.includes('sceneFrameCard'), 'Fused runtime does not call individual Scene Frame card role');
  assert(!roleCalls.includes('sceneConstraintsCard'), 'Fused runtime does not call individual Scene Constraints card role');
  assertEqual(fusedRequest.lane, 'reasoner', 'High Fused card bundle uses Reasoner when healthy');
  assertEqual(fusedRequest.reasoningCategory, 'card', 'Fused card bundle keeps card reasoning category');
  assertEqual(fusedRequest.reasoningIntent, 'minimal', 'High Fused card bundle keeps card reasoning intent');
  assertEqual(fusedRequest.requestedCards.length, 2, 'Fused runtime sends both requested cards in one request');
  assert(result.packet.sections.cardEvidence.includes('FUSED_RUNTIME_SCENE_FRAME'), 'Fused Scene Frame reaches packet evidence');
  assert(result.packet.sections.cardEvidence.includes('FUSED_RUNTIME_CONSTRAINT'), 'Fused Constraints reaches packet evidence');
  assertEqual(result.packet.diagnostics.pipelineMode, 'fused', 'Fused prompt packet records pipeline mode');
  const settledFusedProgress = createProgressRunModel(runtime.view());
  assertEqual(settledFusedProgress.steps.some((step) => step.state === 'running'), false, 'Fused waiting clears running progress after completion');
  assertEqual(runtime.view().activity.label, 'Recursion prompt ready.', 'Fused runtime settles prompt-ready after completion');
}

{
  const roleCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { pipelineMode: 'fused', mode: 'auto', reasoningLevel: 'low', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              sceneStatus: 'same-scene',
              promptFootprint: 'normal',
              cardJobs: [
                { family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Valid fused sibling.' },
                { family: 'Scene Constraints', role: 'sceneConstraintsCard', reason: 'Damaged fused sibling.' }
              ],
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              reasonerDecision: { mode: 'skip', reason: 'targeted fused repair', signals: [] },
              diagnostics: ['targeted-fused-repair-plan']
            }
          };
        }
        if (roleId === 'fusedCardBundle') {
          return {
            ok: true,
            roleId,
            lane: request.lane,
            data: {
              schema: 'recursion.cardBundle.v1',
              snapshotHash: request.snapshotHash,
              items: [
                {
                  schema: 'recursion.card.v1',
                  family: 'Scene Frame',
                  role: 'sceneFrameCard',
                  promptText: 'FUSED_PARTIAL_VALID_SCENE: keep this fused sibling.',
                  evidenceRefs: ['message:2'],
                  tokenEstimate: 18
                },
                {
                  schema: 'recursion.card.v1',
                  family: 'Scene Constraints',
                  role: 'sceneConstraintsCard',
                  promptText: 'The hidden chain of thought says this sibling is damaged.',
                  evidenceRefs: ['message:2'],
                  tokenEstimate: 18
                }
              ]
            }
          };
        }
        if (roleId === 'sceneConstraintsCard') {
          return {
            ok: true,
            roleId,
            data: {
              schema: 'recursion.card.v1',
              role: 'sceneConstraintsCard',
              family: 'Scene Constraints',
              snapshotHash: request.snapshotHash,
              items: [{
                promptText: 'FUSED_TARGETED_REPAIR_CONSTRAINT: repaired only the damaged sibling.',
                evidenceRefs: ['message:2'],
                tokenEstimate: 16
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
              guidanceText: 'Use fused partial repair cards.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['targeted-fused-repair-guidance']
            }
          };
        }
        throw new Error(`unexpected targeted fused repair role ${roleId}`);
      },
      async batch(requests = [], options = {}) {
        const results = [];
        for (const request of requests) {
          results.push(await this.generate(request.roleId, request, options));
        }
        return results;
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Repair only damaged fused card.' });
  assertEqual(result.ok, true, 'Fused targeted repair installs prompt');
  assertDeepEqual(roleCalls, ['utilityArbiter', 'fusedCardBundle', 'sceneConstraintsCard', 'guidanceComposer'], 'Fused targeted repair reruns only damaged requested sibling');
  assert(!roleCalls.includes('sceneFrameCard'), 'Fused targeted repair does not rerun valid fused sibling');
  assert(result.packet.sections.cardEvidence.includes('FUSED_PARTIAL_VALID_SCENE'), 'valid fused sibling reaches packet');
  assert(result.packet.sections.cardEvidence.includes('FUSED_TARGETED_REPAIR_CONSTRAINT'), 'repaired sibling reaches packet');
  assert(result.plan.diagnostics.includes('fused-partial-repair-standard'), 'plan records targeted repair path');
  assert(result.plan.diagnostics.includes('fused-repair:Scene Constraints'), 'targeted repair names repaired family');
  assert(!result.plan.diagnostics.includes('fused-repair:Scene Frame'), 'targeted repair does not name accepted fused family');
  assert(!result.plan.diagnostics.includes('fused-fallback-standard'), 'targeted repair is not full Standard fallback');
}

{
  const roleCalls = [];
  let fusedRequest = null;
  const { runtime } = createRuntimeHarness({
    settings: { pipelineMode: 'fused', mode: 'auto', reasoningLevel: 'low', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Need fallback frame.' }],
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              reasonerDecision: { mode: 'skip', reason: 'unit fused fallback', signals: [] },
              diagnostics: ['fused-fallback-plan']
            }
          };
        }
        if (roleId === 'fusedCardBundle') {
          fusedRequest = request;
          return {
            ok: true,
            roleId,
            data: { schema: 'wrong.schema', snapshotHash: request.snapshotHash, items: [] }
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
                promptText: 'FUSED_FALLBACK_STANDARD_CARD: Standard card fallback recovered.',
                evidenceRefs: ['message:2'],
                tokenEstimate: 16
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
              guidanceText: 'Use fallback card.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['fused-fallback-guidance']
            }
          };
        }
        throw new Error(`unexpected Fused fallback role ${roleId}`);
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Recover from unusable fused bundle.' });
  assertEqual(result.ok, true, 'Fused fallback installs prompt');
  assertEqual(fusedRequest.lane, 'utility', 'Low Fused card bundle stays on Utility');
  assertEqual(fusedRequest.reasoningIntent, undefined, 'Utility Fused card bundle does not carry Reasoner reasoning intent');
  assertDeepEqual(roleCalls, ['utilityArbiter', 'fusedCardBundle', 'sceneFrameCard', 'guidanceComposer'], 'unusable Fused bundle falls back to Standard card generation');
  assert(result.plan.diagnostics.includes('fused-fallback-standard'), 'Fused fallback records Standard fallback diagnostic');
  assert(result.plan.diagnostics.includes('fused-bundle-schema-mismatch'), 'Fused fallback keeps bundle validation diagnostic');
  assert(result.packet.sections.cardEvidence.includes('FUSED_FALLBACK_STANDARD_CARD'), 'Standard fallback card reaches packet evidence');
  assertEqual(result.packet.diagnostics.pipelineMode, 'fused', 'Fused fallback packet still records requested pipeline mode');
}

{
  const roleCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { pipelineMode: 'fused', mode: 'auto', reasoningLevel: 'low', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              cardJobs: [
                { family: 'Scene Frame', role: 'sceneFrameCard', reason: 'No recoverable fused item.' },
                { family: 'Scene Constraints', role: 'sceneConstraintsCard', reason: 'No recoverable fused item.' }
              ],
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              reasonerDecision: { mode: 'skip', reason: 'full fallback boundary', signals: [] },
              diagnostics: ['fused-full-fallback-boundary']
            }
          };
        }
        if (roleId === 'fusedCardBundle') {
          return {
            ok: true,
            roleId,
            data: { schema: 'wrong.schema', snapshotHash: request.snapshotHash, items: [] }
          };
        }
        if (roleId === 'sceneFrameCard' || roleId === 'sceneConstraintsCard') {
          return {
            ok: true,
            roleId,
            data: {
              schema: 'recursion.card.v1',
              role: roleId,
              family: roleId === 'sceneFrameCard' ? 'Scene Frame' : 'Scene Constraints',
              snapshotHash: request.snapshotHash,
              items: [{
                promptText: `${roleId === 'sceneFrameCard' ? 'FULL_FALLBACK_SCENE' : 'FULL_FALLBACK_CONSTRAINT'} recovered from full Standard fallback.`,
                evidenceRefs: ['message:2'],
                tokenEstimate: 16
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
              guidanceText: 'Use full fallback cards.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['full-fallback-guidance']
            }
          };
        }
        throw new Error(`unexpected full fallback role ${roleId}`);
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Fallback only when nothing is salvageable.' });
  assertEqual(result.ok, true, 'full fallback still succeeds when Fused has no recoverable items');
  assert(roleCalls.includes('sceneFrameCard'), 'full fallback regenerates Scene Frame');
  assert(roleCalls.includes('sceneConstraintsCard'), 'full fallback regenerates Scene Constraints');
  assert(result.plan.diagnostics.includes('fused-fallback-standard'), 'full fallback diagnostic remains for zero trusted fused cards');
}

{
  const generatedCardTextByRole = {
    sceneFrameCard: 'SG1_SCENE_FRAME_CARD: ONeill holds the parking-lot line and must choose proof or withdrawal.',
    activeCastCard: 'SG1_ACTIVE_CAST_CARD: Carter verifies the construct while Daniel and Tealc hold position.',
    characterMotivationCard: 'SG1_MOTIVATION_CARD: ONeill needs leverage before accepting Will offer.',
    dialogueRelationshipCard: 'SG1_RELATIONSHIP_CARD: Will presses recruitment while SG-1 distrust stays visible.',
    knowledgeSecretsCard: 'SG1_KNOWLEDGE_CARD: Simulation boundary, idle gate, no DHD, and Tuesday loop stay true.',
    openThreadsCard: 'SG1_OPEN_THREADS_CARD: Immediate unresolved thread is proof demand versus gate withdrawal.'
  };
  const guidancePrompts = [];
  const { runtime, installed } = createRuntimeHarness({
    settings: {
      mode: 'auto',
      pipelineMode: 'standard',
      reasoningLevel: 'medium',
      reasonerUse: 'off',
      promptFootprint: 'normal',
      minCards: 5,
      maxCards: 12
    },
    generationRouter: {
      async generate(roleId, request) {
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'refresh-cards',
              sceneStatus: 'same-scene',
              promptFootprint: 'normal',
              cardJobs: Object.keys(generatedCardTextByRole).map((role) => ({ role, reason: `Generate ${role}.` })),
              reasonerDecision: { mode: 'skip', reason: 'unit all generated cards', signals: [] },
              budgets: { targetBriefTokens: 500, maxCards: 8 },
              diagnostics: ['all-generated-cards']
            }
          };
        }
        if (roleId === 'guidanceComposer') {
          guidancePrompts.push(request.prompt);
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'Use every generated card.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['all-generated-guidance']
            }
          };
        }
        const text = generatedCardTextByRole[roleId];
        if (!text) throw new Error(`unexpected role ${roleId}`);
        return {
          ok: true,
          roleId,
          data: {
            schema: 'recursion.card.v1',
            role: roleId,
            family: request.metadata.family,
            snapshotHash: request.snapshotHash,
            items: [{
              promptText: text,
              evidenceRefs: ['message:2'],
              tokenEstimate: roleId === 'activeCastCard' ? 260 : (roleId === 'sceneFrameCard' ? 130 : 135)
            }]
          }
        };
      },
      async batch(requests) {
        return Promise.all(requests.map((request) => this.generate(request.roleId, request)));
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Use every generated SG-1 card.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'all generated card run installs prompt');
  assertEqual(view.lastHand.cards.length, 6, 'legacy target brief budget does not drop generated active cards');
  assertEqual(view.lastPacket.selectedCardRefs.length, 6, 'prompt packet refs include every generated active card');
  const guidancePrompt = guidancePrompts[0] || '';
  const installedCardEvidence = packetToPromptBlocks(installed[0] || {}).find((block) => block.id === 'cardEvidence')?.text || '';
  for (const marker of Object.values(generatedCardTextByRole)) {
    assert(guidancePrompt.includes(marker), `guidance composer receives ${marker}`);
    assert(view.lastPacket.sections.cardEvidence.includes(marker), `card evidence injects ${marker}`);
    assert(installedCardEvidence.includes(marker), `installed prompt includes ${marker}`);
  }
}

{
  const requestedFamilies = CARD_CATALOG.map((entry) => entry.family);
  const generatedRoles = [];
  const guidancePrompts = [];
  const { runtime } = createRuntimeHarness({
    settings: {
      mode: 'auto',
      pipelineMode: 'standard',
      reasoningLevel: 'medium',
      reasonerUse: 'off',
      strength: 'strong',
      promptFootprint: 'rich',
      minCards: 5,
      maxCards: 12
    },
    generationRouter: {
      async generate(roleId, request) {
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'refresh-cards',
              sceneStatus: 'same-scene',
              promptFootprint: 'rich',
              cardJobs: CARD_CATALOG.map((entry) => ({
                family: entry.family,
                role: entry.role,
                reason: `Generate ${entry.family}.`
              })),
              reasonerDecision: { mode: 'skip', reason: 'cost regression fixture', signals: [] },
              budgets: { targetBriefTokens: 500, maxCards: 6 },
              diagnostics: ['cost-regression-fixture']
            }
          };
        }
        if (roleId === 'guidanceComposer') {
          guidancePrompts.push(request.prompt);
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'Keep the selected cards only.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['guidance-ok']
            }
          };
        }
        generatedRoles.push(roleId);
        return {
          ok: true,
          roleId,
          data: {
            schema: 'recursion.card.v1',
            role: request.metadata.role,
            family: request.metadata.family,
            snapshotHash: request.snapshotHash,
            items: [{
              promptText: `Keep ${request.metadata.family} active for this turn; preserve only evidence-backed constraints.`,
              evidenceRefs: ['message:2'],
              tokenEstimate: 140
            }]
          }
        };
      },
      async batch(requests) {
        return Promise.all(requests.map((request) => this.generate(request.roleId, request)));
      }
    }
  });

  const result = await runtime.prepareForGeneration({ userMessage: 'Cost regression turn.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'cost regression run installs prompt');
  assertEqual(generatedRoles.length, 6, 'runtime does not call providers for card jobs beyond the hand budget');
  assertDeepEqual(
    view.lastHand.cards.map((card) => card.family),
    ['Scene Frame', 'Scene Constraints', 'Active Cast', 'Knowledge', 'Consequences', 'Character Motivation'],
    'runtime hand uses the budgeted high-priority generated families'
  );
  assertEqual(view.lastHand.omitted.filter((entry) => entry.reason === 'max-cards').length, 0, 'ungenerated over-budget cards are not later omitted from the hand');
  assert(view.lastPlan.diagnostics.includes('card-jobs-budgeted'), 'runtime records card job budgeting diagnostic');
  assert(guidancePrompts[0].includes('Character Motivation'), 'guidance sees the last kept selected family');
  for (const family of requestedFamilies.slice(6)) {
    assert(!guidancePrompts[0].includes(`Keep ${family} active`), `${family} was not generated for discarded evidence`);
  }
}

{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        if (roleId !== 'utilityArbiter') throw new Error(`unexpected generate role ${roleId}`);
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            cardJobs: [{ role: 'sceneFrameCard', reason: 'Need a scene frame.' }],
            budgets: { targetBriefTokens: 500, maxCards: 6 },
            diagnostics: ['retried-card-plan']
          }
        };
      },
      async batch(requests) {
        return requests.map((request) => ({
          ok: true,
          roleId: request.roleId,
          lane: 'utility',
          diagnostics: { retryCount: 1 },
          data: {
            schema: 'recursion.card.v1',
            role: request.metadata.role,
            family: request.metadata.family,
            snapshotHash: request.snapshotHash,
            items: [{
              promptText: 'The room remains tense after the interruption.',
              summary: 'Scene frame summary.',
              evidenceRefs: ['message:2'],
              tokenEstimate: 18
            }]
          }
        }));
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Generate retried card job.' });
  const view = runtime.view();
  const progressEvent = view.activityHistory.find((event) => event.phase === 'cardProgress'
    && event.detail?.roleId === 'sceneFrameCard');
  assertEqual(result.ok, true, 'retried provider card still completes the runtime');
  assertEqual(progressEvent.detail.source, 'generated', 'retried provider card remains a generated card');
  assertEqual(progressEvent.detail.state, 'warning', 'retried provider card emits caution progress');
  assertEqual(progressEvent.detail.retryCount, 1, 'retried provider card progress carries retry count');
  assert(progressEvent.detail.reason.includes('retried once'), 'retried provider card progress explains the caution');
}

{
  const manualNoScene = scopeWithOnlyFamilies(['Open Threads']);
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'manual', cardScope: manualNoScene, reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          const cardScope = parsePromptJsonSection(request.prompt, 'Card scope');
          const allowedCatalog = parsePromptJsonSection(request.prompt, 'Catalog');
          assertEqual(cardScope.strictWhitelist, true, 'Manual Arbiter prompt is strict');
          assert(!allowedCatalog.some((entry) => entry.family === 'Scene Frame'), 'Manual allowed catalog omits disabled family');
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              cardJobs: [
                { family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Disabled family must be omitted.' },
                { family: 'Open Threads', role: 'openThreadsCard', reason: 'Keep pending action visible.' }
              ],
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              diagnostics: ['manual-scope-test']
            }
          };
        }
        throw new Error(`Manual disabled-family test expected batch routing, got generate ${roleId}`);
      },
      async batch(requests) {
        routerCalls.push(...requests.map((request) => request.roleId));
        assertDeepEqual(requests.map((request) => request.roleId), ['openThreadsCard'], 'disabled Scene Frame request is never generated');
        return requests.map((request) => ({
          ok: true,
          roleId: request.roleId,
          data: {
            schema: 'recursion.card.v1',
            role: request.metadata.role,
            family: request.metadata.family,
            snapshotHash: request.snapshotHash,
            items: [{
              promptText: 'Keep pending action visible.',
              evidenceRefs: ['message:2'],
              tokenEstimate: 18
            }]
          }
        }));
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Manual scope.' });
  const view = runtime.view();
  const serializedPlan = JSON.stringify(view.lastPlan);
  assertEqual(result.ok, true, 'manual scoped run installs prompt');
  assert(routerCalls.includes('utilityArbiter'), 'manual scoped run calls Arbiter');
  assert(routerCalls.includes('openThreadsCard'), `manual scoped run generates enabled card: ${JSON.stringify(routerCalls)}`);
  assert(!routerCalls.includes('sceneFrameCard'), 'manual scoped run does not generate disabled card');
  assertDeepEqual(view.lastPlan.cardJobs.map((job) => job.family || job.role), ['Open Threads'], 'manual scoped plan keeps only enabled card jobs');
  assert(view.lastHand.cards.some((card) => card.family === 'Open Threads'), 'manual scoped hand includes enabled provider card');
  assert(!view.lastHand.cards.some((card) => card.family === 'Scene Frame'), 'manual scoped hand excludes disabled Scene Frame');
  assert(serializedPlan.includes('manual-scope-omitted:Scene Frame'), 'manual scoped diagnostics record omitted family');
}

{
  const manualForcedScope = scopeWithOnlyFamilies(['Scene Frame', 'Open Threads']);
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'manual', maxCards: 2, cardScope: manualForcedScope, reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              cardJobs: [{ family: 'Open Threads', role: 'openThreadsCard', reason: 'Arbiter chose only threads.' }],
              budgets: { targetBriefTokens: 500, maxCards: 1 },
              diagnostics: ['manual-force-test']
            }
          };
        }
        throw new Error(`Manual forced test expected batch routing, got generate ${roleId}`);
      },
      async batch(requests) {
        routerCalls.push(...requests.map((request) => request.roleId));
        assertDeepEqual(
          requests.map((request) => request.metadata.family).sort(),
          ['Open Threads', 'Scene Frame'].sort(),
          'Manual runtime synthesizes missing selected family job'
        );
        return requests.map((request) => ({
          ok: true,
          roleId: request.roleId,
          data: {
            schema: 'recursion.card.v1',
            role: request.metadata.role,
            family: request.metadata.family,
            snapshotHash: request.snapshotHash,
            items: [{
              promptText: `${request.metadata.family} forced card.`,
              evidenceRefs: ['message:2'],
              tokenEstimate: 18
            }]
          }
        }));
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Manual force selected cards.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'manual forced run installs prompt');
  assert(routerCalls.includes('sceneFrameCard'), 'manual forced run generates Arbiter-omitted selected Scene Frame');
  assert(view.lastHand.cards.some((card) => card.family === 'Scene Frame'), 'manual forced hand includes Scene Frame');
  assert(view.lastHand.cards.some((card) => card.family === 'Open Threads'), 'manual forced hand includes Open Threads');
  assertEqual(view.lastHand.metadata.maxCards >= 2, true, 'manual forced hand floors budget to selected family count');
  assertDeepEqual(view.lastHand.metadata.forcedFamilies, ['Scene Frame', 'Open Threads'], 'manual forced hand metadata records selected families');
  assert(JSON.stringify(view.lastPlan).includes('manual-forced-card:Scene Frame'), 'manual forced diagnostic records synthesized card');
}

{
  const manualScope = scopeWithOnlyFamilies(['Scene Frame', 'Open Threads']);
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'manual', maxCards: 2, cardScope: manualScope, reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              cardJobs: [],
              budgets: { targetBriefTokens: 500, maxCards: 2 }
            }
          };
        }
        throw new Error(`Expected batch, got ${roleId}`);
      },
      async batch(requests) {
        return requests.map((request) => request.metadata.family === 'Scene Frame'
          ? { ok: false, roleId: request.roleId, error: { code: 'TEST_FORCED_FAILURE' } }
          : {
              ok: true,
              roleId: request.roleId,
              data: {
                schema: 'recursion.card.v1',
                role: request.metadata.role,
                family: request.metadata.family,
                snapshotHash: request.snapshotHash,
                items: [{ promptText: 'Threads card.', evidenceRefs: ['message:2'], tokenEstimate: 18 }]
              }
            });
      }
    }
  });
  await runtime.prepareForGeneration({ userMessage: 'Manual forced failure.' });
  const view = runtime.view();
  assert(view.lastHand.cards.some((card) => card.family === 'Open Threads'), 'valid forced family remains selected');
  assert(JSON.stringify(view.lastPacket).includes('Open Threads'), 'valid forced family reaches the packet');
  assert(
    view.lastPacket.omissions.some((entry) => entry.family === 'Scene Frame' && entry.reason === 'manual-forced-provider-failed'),
    'failed forced family reaches packet omissions'
  );
  assert(JSON.stringify(view.lastPlan).includes('manual-forced-card:Scene Frame'), 'failed forced family is diagnosable');
}

{
  const autoNoConstraints = scopeWithFamilyDisabled('Scene Constraints');
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', cardScope: autoNoConstraints, reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          const cardScope = parsePromptJsonSection(request.prompt, 'Card scope');
          const availableCatalog = parsePromptJsonSection(request.prompt, 'Catalog');
          assertEqual(cardScope.strictWhitelist, false, 'Auto Arbiter prompt is focus, not strict');
          assert(
            request.prompt.includes('Auto card scope policy: selected families and sub-items are the preferred focus, not a whitelist. Prefer selected scope when it can satisfy the turn; request unselected families only when they have high relevance to scene constraints, scene coherence, or the current user message.'),
            'Auto Arbiter prompt explains selected card scope is bias with high-relevance exceptions'
          );
          assert(availableCatalog.some((entry) => entry.family === 'Scene Constraints'), 'Auto catalog keeps disabled-focus Scene Constraints available');
          assertDeepEqual(cardScope.selectedSubItemsByFamily['Scene Constraints'], undefined, 'Auto scope preference omits disabled Scene Constraints sub-items');
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              cardJobs: [{ family: 'Scene Constraints', role: 'sceneConstraintsCard', reason: 'Critical risk exception.' }],
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              diagnostics: ['auto-scope-test']
            }
          };
        }
        throw new Error(`Auto focus test expected batch routing, got generate ${roleId}`);
      },
      async batch(requests) {
        routerCalls.push(...requests.map((request) => request.roleId));
        assertDeepEqual(requests.map((request) => request.roleId), ['sceneConstraintsCard'], 'Auto keeps disabled-focus critical card job available');
        assertDeepEqual(requests[0].cardScope.selectedSubItems, [], 'Auto request carries empty selected sub-item focus for disabled family');
        return requests.map((request) => ({
          ok: true,
          roleId: request.roleId,
          data: {
            schema: 'recursion.card.v1',
            role: request.metadata.role,
            family: request.metadata.family,
            snapshotHash: request.snapshotHash,
            items: [{
              promptText: 'Do not contradict the broken lamp.',
              evidenceRefs: ['message:2'],
              tokenEstimate: 18
            }]
          }
        }));
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Auto focus.' });
  const view = runtime.view();
  const serializedPlan = JSON.stringify(view.lastPlan);
  assertEqual(result.ok, true, 'auto scoped run installs prompt');
  assert(routerCalls.includes('sceneConstraintsCard'), 'auto scoped run generates disabled-focus critical card');
  assert(view.lastHand.cards.some((card) => card.family === 'Scene Constraints'), 'auto scoped hand can include critical disabled-focus exception');
  assert(serializedPlan.includes('auto-scope-exception:Scene Constraints'), 'auto scoped diagnostics record compact exception family');
  assert(!serializedPlan.includes('Do not contradict'), 'auto scope diagnostics do not include prompt text');
}

{
  const autoNoEnvironment = scopeWithFamilyDisabled('Environment');
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', cardScope: autoNoEnvironment, reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              cardJobs: [{ family: 'Environment', role: 'environmentAffordancesCard', reason: 'High relevance style risk.' }],
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              diagnostics: ['auto-non-continuity-exception-test']
            }
          };
        }
        throw new Error(`Auto non-continuity exception test expected batch routing, got generate ${roleId}`);
      },
      async batch(requests) {
        assertDeepEqual(requests.map((request) => request.roleId), ['environmentAffordancesCard'], 'Auto allows disabled-focus non-continuity card when Arbiter marks it relevant');
        return requests.map((request) => ({
          ok: true,
          roleId: request.roleId,
          data: {
            schema: 'recursion.card.v1',
            role: request.metadata.role,
            family: request.metadata.family,
            snapshotHash: request.snapshotHash,
            items: [{
              promptText: 'Keep the response tight and concrete.',
              evidenceRefs: ['message:2'],
              tokenEstimate: 18
            }]
          }
        }));
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Auto non-continuity scope.' });
  const view = runtime.view();
  const serializedPlan = JSON.stringify(view.lastPlan);
  assertEqual(result.ok, true, 'auto scoped non-continuity run installs prompt');
  assert(view.lastHand.cards.some((card) => card.family === 'Environment'), 'auto scoped hand can include high-relevance disabled-focus non-continuity card');
  assert(serializedPlan.includes('auto-scope-exception:Environment'), 'auto scoped diagnostics record compact exception for non-continuity family');
  assert(!serializedPlan.includes('Keep the response tight'), 'auto non-continuity diagnostics do not include prompt text');
}

{
  const routerCalls = [];
  const cardSnapshots = [];
  const cardStarts = [];
  let firstCardCompleted = false;
  const { runtime, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              cardJobs: [
                { role: 'openThreadsCard', reason: 'Need one sequential open thread card.' },
                { role: 'sceneConstraintsCard', reason: 'Need one invalid sequential continuity card.' }
              ],
              budgets: { targetBriefTokens: 500, maxCards: 6 },
              diagnostics: ['sequential-provider-card-plan']
            }
          };
        }
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'Sequential guidance.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['sequential-guidance']
            }
          };
        }
        cardStarts.push({ roleId, firstCardCompletedAtStart: firstCardCompleted });
        cardSnapshots.push({ roleId, runId: request.runId, snapshotHash: request.snapshotHash, signal: request.signal, hasSignal: isAbortSignal(request.signal) });
        if (roleId === 'sceneConstraintsCard') {
          return {
            ok: true,
            roleId,
            data: {
              schema: 'recursion.card.v1',
              role: 'sceneConstraintsCard',
              family: 'Scene Constraints',
              snapshotHash: 'wrong-sequential-snapshot',
              items: [{
                promptText: 'This invalid sequential card should be omitted.',
                evidenceRefs: ['message:2'],
                tokenEstimate: 18
              }]
            }
          };
        }
        await Promise.resolve();
        firstCardCompleted = true;
        return {
          ok: true,
          roleId,
          data: {
            schema: 'recursion.card.v1',
            role: 'openThreadsCard',
            family: 'Open Threads',
            snapshotHash: request.snapshotHash,
            items: [{
              promptText: 'The sequential provider call keeps the unanswered signal active.',
              summary: 'Sequential open thread summary.',
              evidenceRefs: ['message:2'],
              tokenEstimate: 18
            }]
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Generate sequential card job.' });
  const view = runtime.view();
  const cache = await storage.loadSceneCache(view.lastSnapshot.chatKey, view.lastSnapshot.sceneKey);
  assertEqual(result.ok, true, 'sequential provider card job run installs prompt');
  assertDeepEqual(routerCalls, ['utilityArbiter', 'openThreadsCard', 'sceneConstraintsCard', 'guidanceComposer'], 'router without batch runs card jobs sequentially then composes guidance');
  assertEqual(cardStarts[1].firstCardCompletedAtStart, true, 'second sequential card starts after first resolves');
  assertEqual(cardSnapshots.length, 2, 'sequential card jobs capture frozen requests');
  assert(cardSnapshots.every((entry) => entry.snapshotHash === result.plan.snapshotHash), 'sequential card jobs use frozen plan snapshot hash');
  assert(cardSnapshots.every((entry) => entry.runId === view.lastPacket.diagnostics.runId), 'sequential card jobs use shared run id');
  assert(cardSnapshots.every((entry) => entry.signal === cardSnapshots[0].signal && entry.hasSignal), 'sequential card jobs share abort signal object');
  assert(cache.cards.some((card) => card.family === 'Open Threads'), 'sequential provider card persisted in scene cache');
  assert(!cache.cards.some((card) => card.family === 'Scene Constraints'), 'invalid sequential provider card is omitted independently');
  assert(view.lastHand.cards.some((card) => card.family === 'Open Threads'), 'sequential provider card selected into hand');
  assert(view.lastPacket.sections.cardEvidence.includes('sequential provider call'), 'sequential provider card reaches prompt packet');
  assert(!cache.cards.some((card) => card.family === 'Scene Frame'), 'sequential provider card pass does not add local Scene Frame fallback card');
}

{
  let delegateRouter = null;
  const providerActivity = createActivityReporter();
  const fetchCalls = [];
  const { runtime, storage, settingsStore } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      generate(roleId, request, options) {
        return delegateRouter.generate(roleId, request, options);
      },
      batch(requests, options) {
        return delegateRouter.batch(requests, options);
      }
    }
  });
  settingsStore.updateProvider('utility', {
    source: 'openai-compatible',
    apiKey: 'session-key',
    openAICompatible: { baseUrl: 'https://semantic-repair.example/v1', model: 'utility-model' },
    maxTokens: 4096
  });
  delegateRouter = createGenerationRouter({
    activity: providerActivity,
    client: createProviderClient({
      settingsStore,
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        fetchCalls.push({ url, body });
        const expectedSchema = body.response_format?.json_schema?.schema?.properties?.schema?.const || '';
        const snapshotHash = body.response_format?.json_schema?.schema?.properties?.snapshotHash?.const || '';
        const prompt = String(body.messages?.[0]?.content || '');
        let content = '';
        if (expectedSchema === UTILITY_ARBITER_SCHEMA) {
          content = [
            'Provider wrapper:',
            `{"schema":"${UTILITY_ARBITER_SCHEMA}","snapshotHash":"${snapshotHash}","action":"compose-brief","cardJobs":[{"role":"openThreadsCard","reason":"Keep valid repaired sibling."},{"role":"sceneConstraintsCard","reason":"Reject repaired stale sibling."}],"budgets":{"targetBriefTokens":500,"maxCards":6},"reasonerDecision":{"mode":"skip","reason":"semantic repair test","signals":[]},"diagnostics":["semantic-repair-arbiter"],}`
          ].join('\n');
        } else if (prompt.includes('sceneConstraintsCard')) {
          content = `<think>draft that must not persist</think>{"schema":"recursion.card.v1","role":"sceneConstraintsCard","family":"Scene Constraints","snapshotHash":"wrong-repaired-hash","items":[{"promptText":"Wrong repaired snapshot card must not enter prompt.","evidenceRefs":["message:2"],"tokenEstimate":12,}],}`;
        } else {
          content = '```json\n'
            + `{"schema":"recursion.card.v1","role":"openThreadsCard","family":"Open Threads","snapshotHash":"${snapshotHash}","items":[{"promptText":"Valid repaired card survives semantic sibling rejection.","evidenceRefs":["message:2"],"tokenEstimate":12,}],}`
            + '\n```';
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: `semantic-repair-${fetchCalls.length}`,
            model: body.model,
            choices: [{ message: { content } }]
          })
        };
      }
    })
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Run repaired semantic rejection.' });
  const view = runtime.view();
  const cache = await storage.loadSceneCache(view.lastSnapshot.chatKey, view.lastSnapshot.sceneKey);
  const serializedRuntime = JSON.stringify({ cache, hand: view.lastHand, packet: view.lastPacket });
  const providerHistory = JSON.stringify(providerActivity.history());
  assertEqual(result.ok, true, 'runtime with repaired provider JSON remains fail-soft');
  assert(fetchCalls.length >= 3, 'real provider router handled arbiter and card provider calls');
  assert(serializedRuntime.includes('Valid repaired card survives semantic sibling rejection'), 'valid repaired sibling reaches runtime prompt');
  assert(!serializedRuntime.includes('Wrong repaired snapshot card'), 'repaired card with wrong snapshot hash is still semantically rejected');
  assert(providerHistory.includes('"structuredOutputRepaired":true'), 'provider diagnostics record syntax repair before runtime semantics');
  assert(!providerHistory.includes('draft that must not persist'), 'provider diagnostics omit stripped hidden reasoning text');
}

{
  const routerCalls = [];
  const { runtime, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              cardJobs: [
                { role: 'openThreadsCard', reason: 'Keep the first sequential card.' },
                { role: 'sceneConstraintsCard', reason: 'This thrown card should not poison the first.' }
              ],
              budgets: { targetBriefTokens: 500, maxCards: 6 },
              diagnostics: ['sequential-provider-throw-plan']
            }
          };
        }
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'Sequential failure guidance.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['sequential-failure-guidance']
            }
          };
        }
        if (roleId === 'sceneConstraintsCard') {
          throw new Error('sequential card provider failed');
        }
        return {
          ok: true,
          roleId,
          data: {
            schema: 'recursion.card.v1',
            role: 'openThreadsCard',
            family: 'Open Threads',
            snapshotHash: request.snapshotHash,
            items: [{
              promptText: 'The first sequential card survives a later card failure.',
              evidenceRefs: ['message:2'],
              tokenEstimate: 18
            }]
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Generate with one throwing sequential card.' });
  const view = runtime.view();
  const cache = await storage.loadSceneCache(view.lastSnapshot.chatKey, view.lastSnapshot.sceneKey);
  assertEqual(result.ok, true, 'sequential thrown card job run still installs prompt');
  assertDeepEqual(routerCalls, ['utilityArbiter', 'openThreadsCard', 'sceneConstraintsCard', 'guidanceComposer'], 'throwing sequential card job is attempted after first card then composes guidance');
  assert(cache.cards.some((card) => card.family === 'Open Threads'), 'successful sequential card persists despite later throw');
  assert(!cache.cards.some((card) => card.family === 'Scene Constraints'), 'throwing sequential card is omitted independently');
  assert(view.lastPacket.sections.cardEvidence.includes('survives a later card failure'), 'successful sequential card reaches prompt after later throw');
  assert(!cache.cards.some((card) => card.family === 'Scene Frame'), 'sequential per-card failure does not force local fallback');
}

{
  const routerCalls = [];
  let runtimeForSupersede = null;
  let disposedDuringFirstCard = false;
  const harness = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              cardJobs: [
                { role: 'openThreadsCard', reason: 'Supersede after this card.' },
                { role: 'sceneConstraintsCard', reason: 'This card must not start after supersession.' }
              ],
              budgets: { targetBriefTokens: 500, maxCards: 6 },
              diagnostics: ['sequential-supersession-plan']
            }
          };
        }
        if (roleId === 'openThreadsCard' && !disposedDuringFirstCard) {
          disposedDuringFirstCard = true;
          await runtimeForSupersede.dispose();
        }
        return {
          ok: true,
          roleId,
          data: {
            schema: 'recursion.card.v1',
            role: request.metadata.role,
            family: request.metadata.family,
            snapshotHash: request.snapshotHash,
            items: [{
              promptText: 'Superseded sequential card.',
              evidenceRefs: ['message:2'],
              tokenEstimate: 18
            }]
          }
        };
      }
    }
  });
  runtimeForSupersede = harness.runtime;
  const result = await harness.runtime.prepareForGeneration({ userMessage: 'Supersede sequential card pass.' });
  assertEqual(result.superseded, true, 'sequential card pass returns superseded after dispose');
  assertDeepEqual(routerCalls, ['utilityArbiter', 'openThreadsCard'], 'sequential card pass stops before launching next card after supersession');
}

{
  const { runtime, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            cardJobs: [{ role: 'openThreadsCard', reason: 'Need one open thread card.' }],
            budgets: { targetBriefTokens: 500, maxCards: 6 },
            diagnostics: ['identityless-provider-envelope']
          }
        };
      },
      async batch(requests) {
        return requests.map((request) => ({
          ok: true,
          roleId: request.roleId,
          data: {
            schema: 'recursion.card.v1',
            items: [{
              promptText: 'Identityless provider card is repaired from request-owned role and family.',
              evidenceRefs: ['message:2'],
              tokenEstimate: 12
            }]
          }
        }));
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Repair identityless card envelope.' });
  const view = runtime.view();
  const cache = await storage.loadSceneCache(view.lastSnapshot.chatKey, view.lastSnapshot.sceneKey);
  const serialized = JSON.stringify({ cache, hand: view.lastHand, packet: view.lastPacket });
  assertEqual(result.ok, true, 'identityless provider envelope run remains fail-soft');
  assert(serialized.includes('Identityless provider card is repaired from request-owned role and family.'), 'identityless provider envelope is accepted from request-owned role and family');
  assert(view.lastHand.cards.some((card) => card.family === 'Open Threads'), 'identityless provider envelope repairs expected family');
}

{
  const { runtime, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            cardJobs: [{ role: 'openThreadsCard', reason: 'Need one open thread card.' }],
            budgets: { targetBriefTokens: 500, maxCards: 6 },
            diagnostics: ['wrong-role-provider-envelope']
          }
        };
      },
      async batch(requests) {
        return [{
          ok: true,
          roleId: 'sceneConstraintsCard',
          data: {
            schema: 'recursion.card.v1',
            role: 'sceneConstraintsCard',
            family: 'Scene Constraints',
            snapshotHash: requests[0]?.snapshotHash,
            items: [{
              promptText: 'Wrong returned role must not enter cache or prompt.',
              evidenceRefs: ['message:2'],
              tokenEstimate: 12
            }]
          }
        }];
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Reject wrong role card envelope.' });
  const view = runtime.view();
  const cache = await storage.loadSceneCache(view.lastSnapshot.chatKey, view.lastSnapshot.sceneKey);
  const serialized = JSON.stringify({ cache, hand: view.lastHand, packet: view.lastPacket });
  assertEqual(result.ok, true, 'wrong-role provider envelope run remains fail-soft');
  assert(!serialized.includes('Wrong returned role'), 'provider envelope with role mismatched to request slot is not accepted');
}

{
  const { runtime, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            cardJobs: [{ role: 'openThreadsCard', reason: 'Need one open thread card.' }],
            budgets: { targetBriefTokens: 500, maxCards: 6 },
            diagnostics: ['extra-provider-envelope']
          }
        };
      },
      async batch(requests) {
        return [
          {
            ok: true,
            roleId: requests[0].roleId,
            data: {
              schema: 'recursion.card.v1',
              role: requests[0].metadata.role,
              family: requests[0].metadata.family,
              snapshotHash: requests[0].snapshotHash,
              items: [{
                promptText: 'Expected provider card may enter cache.',
                evidenceRefs: ['message:2'],
                tokenEstimate: 12
              }]
            }
          },
          {
            ok: true,
            roleId: 'sceneFrameCard',
            data: {
              schema: 'recursion.card.v1',
              role: 'sceneFrameCard',
              family: 'Scene Frame',
              items: [{
                promptText: 'Extra provider result must not enter cache or prompt.',
                evidenceRefs: ['message:2'],
                tokenEstimate: 12
              }]
            }
          }
        ];
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Reject extra card envelope.' });
  const view = runtime.view();
  const cache = await storage.loadSceneCache(view.lastSnapshot.chatKey, view.lastSnapshot.sceneKey);
  const serialized = JSON.stringify({ cache, hand: view.lastHand, packet: view.lastPacket });
  assertEqual(result.ok, true, 'extra provider result run remains fail-soft');
  assert(serialized.includes('Expected provider card'), 'expected provider card remains accepted');
  assert(!serialized.includes('Extra provider result'), 'extra provider result without request metadata is not accepted');
}

{
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  const cacheAwareMessages = [
    { mesid: 1, role: 'assistant', text: 'The shuttle shudders in the storm.', visible: true },
    { mesid: 2, role: 'user', text: 'Mara braces against the hatch.', visible: true },
    { mesid: 3, role: 'user', text: 'Check cached card relevance.', visible: true }
  ];
  const cacheAwareSourceHash = sourceWindowHash(cacheAwareMessages, 1, 2);
  await storage.saveSceneCache('cache-aware-chat', 'cache-aware-scene', {
    versions: cacheContractVersions({ mode: 'auto', reasonerUse: 'off' }),
    cards: [{
      id: 'cache-aware-card',
      family: 'Scene Frame',
      status: 'active',
      promptText: 'Cached scene card the Arbiter should be able to inspect.',
      summary: 'Cached scene summary',
      tokenEstimate: 12,
      evidenceRefs: ['message:2'],
      source: {
        chatId: 'cache-aware-chat',
        firstMesId: 1,
        lastMesId: 2,
        fingerprint: cacheAwareSourceHash,
        snapshotHash: cacheAwareSourceHash
      },
      freshness: { sourceFingerprint: cacheAwareSourceHash }
    }],
    latestHand: {
      handId: 'cache-aware-hand',
      cards: [{ id: 'cache-aware-card', family: 'Scene Frame' }]
    }
  });
  let arbiterPrompt = '';
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    snapshot: {
      chatId: 'cache-aware-chat',
      chatKey: 'cache-aware-chat',
      sceneKey: 'cache-aware-scene',
      sceneFingerprint: 'cache-aware-scene-fp',
      turnFingerprint: 'cache-aware-turn-fp',
      latestMesId: 3,
      messages: cacheAwareMessages
    },
    generationRouter: {
      async generate(roleId, request) {
        assertEqual(roleId, 'utilityArbiter', 'cache-aware test only calls utility arbiter');
        arbiterPrompt = request.prompt;
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'reuse-cache',
            lifecycle: [{ action: 'select', cardId: 'cache-aware-card', reason: 'still relevant' }],
            budgets: { targetBriefTokens: 500, maxCards: 4 },
            diagnostics: ['cache-aware-plan']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Cache-aware Arbiter.' });
  assertEqual(result.ok, true, 'cache-aware arbiter run installs');
  assert(arbiterPrompt.includes('cache-aware-card'), 'arbiter prompt includes compact scene cache card metadata');
  assert(arbiterPrompt.includes('cache-aware-hand'), 'arbiter prompt includes latest hand metadata');
  assertDeepEqual(runtime.view().lastHand.cards.map((card) => card.id), ['cache-aware-card'], 'cache-aware plan reuses selected cached card');
}

for (const scenario of [
  { label: 'card-catalog', versionPatch: { cardCatalogHash: 'old-catalog-contract' } },
  { label: 'provider-contract', versionPatch: { providerContractHash: 'old-provider-contract' } }
]) {
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  const contractMessages = [
    { mesid: 1, role: 'assistant', text: `The ${scenario.label} cache contract should be current.`, visible: true },
    { mesid: 2, role: 'user', text: `Try to reuse a stale ${scenario.label} contract cache card.`, visible: true }
  ];
  const sourceHash = sourceWindowHash(contractMessages, 1, 2);
  await storage.saveSceneCache(`contract-stale-${scenario.label}-chat`, `contract-stale-${scenario.label}-scene`, {
    versions: {
      ...cacheContractVersions({ mode: 'auto', reasonerUse: 'off' }),
      ...scenario.versionPatch
    },
    cards: [{
      id: `contract-stale-${scenario.label}-card`,
      family: 'Scene Frame',
      status: 'active',
      promptText: `Stale ${scenario.label} contract cache card must not reach the prompt.`,
      summary: `Stale ${scenario.label} contract card`,
      tokenEstimate: 12,
      evidenceRefs: ['message:2'],
      source: {
        chatId: `contract-stale-${scenario.label}-chat`,
        firstMesId: 1,
        lastMesId: 2,
        fingerprint: sourceHash,
        snapshotHash: sourceHash
      },
      freshness: { sourceFingerprint: sourceHash }
    }],
    latestHand: {
      handId: `contract-stale-${scenario.label}-hand`,
      cards: [{ id: `contract-stale-${scenario.label}-card`, family: 'Scene Frame' }]
    }
  });
  let arbiterPrompt = '';
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    snapshot: {
      chatId: `contract-stale-${scenario.label}-chat`,
      chatKey: `contract-stale-${scenario.label}-chat`,
      sceneKey: `contract-stale-${scenario.label}-scene`,
      sceneFingerprint: `contract-stale-${scenario.label}-scene-fp`,
      turnFingerprint: `contract-stale-${scenario.label}-turn-fp`,
      latestMesId: 2,
      messages: contractMessages
    },
    generationRouter: {
      async generate(roleId, request) {
        assertEqual(roleId, 'utilityArbiter', 'contract mismatch test only calls utility arbiter');
        arbiterPrompt = request.prompt;
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'reuse-cache',
            lifecycle: [{ action: 'select', cardId: `contract-stale-${scenario.label}-card`, reason: 'stale contract should be ignored' }],
            budgets: { targetBriefTokens: 500, maxCards: 4 },
            diagnostics: [`contract-stale-${scenario.label}-reuse`]
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: `Try to reuse a stale ${scenario.label} contract cache card.` });
  const serialized = JSON.stringify({ result, view: runtime.view() });
  assertEqual(result.ok, true, `${scenario.label} contract-mismatched reuse-cache remains fail-soft`);
  assertEqual(result.skipped, true, `${scenario.label} contract-mismatched cache is treated as unavailable`);
  assertEqual(result.reason, 'cache-unavailable', `${scenario.label} contract-mismatched cache returns unavailable reason`);
  assertEqual(installed.length, 0, `${scenario.label} contract-mismatched cache card does not install prompt`);
  assert(!arbiterPrompt.includes(`contract-stale-${scenario.label}-card`), `${scenario.label} contract-mismatched cache is hidden from Arbiter prompt`);
  assert(!arbiterPrompt.includes(`Stale ${scenario.label} contract card`), `${scenario.label} contract-mismatched cache summary is hidden from Arbiter prompt`);
  assert(!serialized.includes(`Stale ${scenario.label} contract cache card must not reach the prompt`), `${scenario.label} contract-mismatched cache prompt text is not exposed`);
}

{
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  const missingVersionMessages = [
    { mesid: 1, role: 'assistant', text: 'The old pre-version cache exists.', visible: true },
    { mesid: 2, role: 'user', text: 'Try to reuse a missing-version cache card.', visible: true }
  ];
  const sourceHash = sourceWindowHash(missingVersionMessages, 1, 2);
  await storage.saveSceneCache('missing-version-chat', 'missing-version-scene', {
    cards: [{
      id: 'missing-version-card',
      family: 'Scene Frame',
      status: 'active',
      promptText: 'Missing-version cache card must not reach the prompt.',
      summary: 'Missing version card',
      tokenEstimate: 12,
      evidenceRefs: ['message:2'],
      source: {
        chatId: 'missing-version-chat',
        firstMesId: 1,
        lastMesId: 2,
        fingerprint: sourceHash,
        snapshotHash: sourceHash
      },
      freshness: { sourceFingerprint: sourceHash }
    }]
  });
  let arbiterPrompt = '';
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    snapshot: {
      chatId: 'missing-version-chat',
      chatKey: 'missing-version-chat',
      sceneKey: 'missing-version-scene',
      sceneFingerprint: 'missing-version-scene-fp',
      turnFingerprint: 'missing-version-turn-fp',
      latestMesId: 2,
      messages: missingVersionMessages
    },
    generationRouter: {
      async generate(roleId, request) {
        assertEqual(roleId, 'utilityArbiter', 'missing-version contract test only calls utility arbiter');
        arbiterPrompt = request.prompt;
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'reuse-cache',
            lifecycle: [{ action: 'select', cardId: 'missing-version-card', reason: 'missing versions should be ignored' }],
            budgets: { targetBriefTokens: 500, maxCards: 4 },
            diagnostics: ['missing-version-reuse']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Try to reuse a missing-version cache card.' });
  const serialized = JSON.stringify({ result, view: runtime.view() });
  assertEqual(result.ok, true, 'missing-version cache remains fail-soft');
  assertEqual(result.skipped, true, 'missing-version cache is treated as unavailable');
  assertEqual(result.reason, 'cache-unavailable', 'missing-version cache returns unavailable reason');
  assertEqual(installed.length, 0, 'missing-version cache does not install prompt');
  assert(!arbiterPrompt.includes('missing-version-card'), 'missing-version cache is hidden from Arbiter prompt');
  assert(!serialized.includes('Missing-version cache card must not reach the prompt'), 'missing-version prompt text is not exposed');
}

{
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  const softSettingsMessages = [
    { mesid: 1, role: 'assistant', text: 'The cache is still relevant after preference changes.', visible: true },
    { mesid: 2, role: 'user', text: 'Reuse the settings-drift cache card.', visible: true }
  ];
  const sourceHash = sourceWindowHash(softSettingsMessages, 1, 2);
  await storage.saveSceneCache('settings-drift-chat', 'settings-drift-scene', {
    versions: cacheContractVersions({ mode: 'manual' }),
    cards: [{
      id: 'settings-drift-card',
      family: 'Scene Frame',
      status: 'active',
      promptText: 'Settings drift cache card remains reviewable.',
      summary: 'Settings drift card',
      tokenEstimate: 12,
      evidenceRefs: ['message:2'],
      source: {
        chatId: 'settings-drift-chat',
        firstMesId: 1,
        lastMesId: 2,
        fingerprint: sourceHash,
        snapshotHash: sourceHash
      },
      freshness: { sourceFingerprint: sourceHash }
    }],
    latestHand: {
      handId: 'settings-drift-hand',
      cards: [{ id: 'settings-drift-card', family: 'Scene Frame' }]
    }
  });
  let arbiterPrompt = '';
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    snapshot: {
      chatId: 'settings-drift-chat',
      chatKey: 'settings-drift-chat',
      sceneKey: 'settings-drift-scene',
      sceneFingerprint: 'settings-drift-scene-fp',
      turnFingerprint: 'settings-drift-turn-fp',
      latestMesId: 2,
      messages: softSettingsMessages
    },
    generationRouter: {
      async generate(roleId, request) {
        assertEqual(roleId, 'utilityArbiter', 'settings drift test only calls utility arbiter');
        arbiterPrompt = request.prompt;
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'reuse-cache',
            lifecycle: [{ action: 'select', cardId: 'settings-drift-card', reason: 'still relevant after settings drift' }],
            budgets: { targetBriefTokens: 500, maxCards: 4 },
            diagnostics: ['settings-drift-reuse']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Reuse the settings-drift cache card.' });
  const sceneCacheView = parsePromptJsonSection(arbiterPrompt, 'Scene cache');
  assertEqual(result.ok, true, 'settings-drift reuse-cache installs');
  assertEqual(installed.length, 1, 'settings-drift cache remains usable');
  assert(arbiterPrompt.includes('settings-drift-card'), 'settings-drift cache remains visible to Arbiter');
  assertEqual(sceneCacheView.cacheState, 'stale', 'settings-drift cache is marked stale for Arbiter review');
  assertEqual(sceneCacheView.invalidation?.reason, 'settings-changed', 'settings-drift cache tells Arbiter why it is stale');
  assertDeepEqual(runtime.view().lastHand.cards.map((card) => card.id), ['settings-drift-card'], 'settings-drift selected cache card is reused');
}

{
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  const staleMessages = [
    { mesid: 1, role: 'assistant', text: 'The old corridor is no longer reliable.', visible: true },
    { mesid: 2, role: 'user', text: 'The player changed what happened here.', visible: true },
    { mesid: 3, role: 'user', text: 'Try to reuse a stale cache card.', visible: true }
  ];
  await storage.saveSceneCache('stale-cache-chat', 'stale-cache-scene', {
    versions: cacheContractVersions({ mode: 'auto', reasonerUse: 'off' }),
    cards: [{
      id: 'stale-cache-card',
      family: 'Scene Constraints',
      status: 'active',
      promptText: 'Stale cached continuity must not reach the prompt.',
      summary: 'Stale continuity',
      tokenEstimate: 12,
      evidenceRefs: ['message:2'],
      source: {
        chatId: 'stale-cache-chat',
        firstMesId: 1,
        lastMesId: 2,
        fingerprint: 'stale-source-fingerprint',
        snapshotHash: 'stale-source-fingerprint'
      },
      freshness: { sourceFingerprint: 'stale-source-fingerprint' }
    }],
    latestHand: {
      handId: 'stale-cache-hand',
      cards: [{ id: 'stale-cache-card', family: 'Scene Constraints' }]
    }
  });
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    snapshot: {
      chatId: 'stale-cache-chat',
      chatKey: 'stale-cache-chat',
      sceneKey: 'stale-cache-scene',
      sceneFingerprint: 'stale-cache-scene-fp',
      turnFingerprint: 'stale-cache-turn-fp',
      latestMesId: 3,
      messages: staleMessages
    },
    generationRouter: {
      async generate(roleId, request) {
        assertEqual(roleId, 'utilityArbiter', 'stale cache test only calls utility arbiter');
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'reuse-cache',
            lifecycle: [{ action: 'select', cardId: 'stale-cache-card', reason: 'provider thought it was reusable' }],
            budgets: { targetBriefTokens: 500, maxCards: 4 },
            diagnostics: ['stale-cache-reuse']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Try to reuse a stale cache card.' });
  const serialized = JSON.stringify({ result, view: runtime.view() });
  assertEqual(result.ok, true, 'stale reuse-cache remains fail-soft');
  assertEqual(result.skipped, true, 'stale reuse-cache is treated as unavailable');
  assertEqual(result.reason, 'cache-unavailable', 'stale reuse-cache returns unavailable reason');
  assertEqual(installed.length, 0, 'stale cache card does not install prompt');
  assert(!serialized.includes('Stale cached continuity must not reach the prompt'), 'stale cache prompt text is not exposed');
}

{
  const fullHashBypassMessages = [
    { mesid: 1, role: 'assistant', text: 'Old source window.', visible: true },
    { mesid: 2, role: 'user', text: 'User source window.', visible: true },
    { mesid: 3, role: 'user', text: 'Reject full snapshot hash bypass.', visible: true }
  ];
  const snapshot = {
    chatId: 'full-hash-cache-chat',
    chatKey: 'full-hash-cache-chat',
    sceneKey: 'full-hash-cache-scene',
    sceneFingerprint: 'full-hash-cache-scene-fp',
    turnFingerprint: 'full-hash-cache-turn-fp',
    latestMesId: 3,
    messages: fullHashBypassMessages
  };
  await assertSingleCachedCardUnavailable({
    label: 'full-snapshot-hash-cache',
    userMessage: 'Reject full snapshot hash bypass.',
    snapshot,
    card: {
      id: 'full-hash-cache-card',
      family: 'Scene Frame',
      status: 'active',
      promptText: 'Full snapshot hash must not validate stale source window.',
      evidenceRefs: ['message:2'],
      source: {
        chatId: 'full-hash-cache-chat',
        firstMesId: 1,
        lastMesId: 2,
        fingerprint: runtimeSnapshotHash(snapshot),
        snapshotHash: runtimeSnapshotHash(snapshot)
      },
      freshness: { sourceFingerprint: runtimeSnapshotHash(snapshot) }
    }
  });
}

{
  const missingRangeMessages = [
    { mesid: 1, role: 'assistant', text: 'Message one.', visible: true },
    { mesid: 2, role: 'user', text: 'Reject missing source range.', visible: true }
  ];
  const snapshot = {
    chatId: 'missing-range-cache-chat',
    chatKey: 'missing-range-cache-chat',
    sceneKey: 'missing-range-cache-scene',
    sceneFingerprint: 'missing-range-cache-scene-fp',
    turnFingerprint: 'missing-range-cache-turn-fp',
    latestMesId: 2,
    messages: missingRangeMessages
  };
  await assertSingleCachedCardUnavailable({
    label: 'missing-source-range-cache',
    userMessage: 'Reject missing source range.',
    snapshot,
    card: {
      id: 'missing-range-cache-card',
      family: 'Scene Frame',
      status: 'active',
      promptText: 'Missing source range must not be inferred from current snapshot.',
      source: {
        chatId: 'missing-range-cache-chat',
        fingerprint: runtimeSnapshotHash(snapshot),
        snapshotHash: runtimeSnapshotHash(snapshot)
      },
      freshness: { sourceFingerprint: runtimeSnapshotHash(snapshot) }
    }
  });
}

{
  const gappedRangeMessages = [
    { mesid: 1, role: 'assistant', text: 'Visible endpoint one.', visible: true },
    { mesid: 3, role: 'user', text: 'Reject gapped source range.', visible: true }
  ];
  const sourceHash = sourceWindowHash(gappedRangeMessages, 1, 3);
  await assertSingleCachedCardUnavailable({
    label: 'gapped-source-range-cache',
    userMessage: 'Reject gapped source range.',
    snapshot: {
      chatId: 'gapped-cache-chat',
      chatKey: 'gapped-cache-chat',
      sceneKey: 'gapped-cache-scene',
      sceneFingerprint: 'gapped-cache-scene-fp',
      turnFingerprint: 'gapped-cache-turn-fp',
      latestMesId: 3,
      messages: gappedRangeMessages
    },
    card: {
      id: 'gapped-cache-card',
      family: 'Scene Constraints',
      status: 'active',
      promptText: 'Gapped source range must not be reused.',
      evidenceRefs: ['message:3'],
      source: {
        chatId: 'gapped-cache-chat',
        firstMesId: 1,
        lastMesId: 3,
        fingerprint: sourceHash,
        snapshotHash: sourceHash
      },
      freshness: { sourceFingerprint: sourceHash }
    }
  });
}

{
  const malformedEvidenceMessages = [
    { mesid: 1, role: 'assistant', text: 'Valid source start.', visible: true },
    { mesid: 2, role: 'user', text: 'Reject malformed evidence ref.', visible: true },
    { mesid: 4, role: 'assistant', text: 'Outside evidence target.', visible: true }
  ];
  const sourceHash = sourceWindowHash(malformedEvidenceMessages, 1, 2);
  await assertSingleCachedCardUnavailable({
    label: 'malformed-evidence-cache',
    userMessage: 'Reject malformed evidence ref.',
    snapshot: {
      chatId: 'malformed-evidence-chat',
      chatKey: 'malformed-evidence-chat',
      sceneKey: 'malformed-evidence-scene',
      sceneFingerprint: 'malformed-evidence-scene-fp',
      turnFingerprint: 'malformed-evidence-turn-fp',
      latestMesId: 4,
      messages: malformedEvidenceMessages
    },
    card: {
      id: 'malformed-evidence-card',
      family: 'Scene Constraints',
      status: 'active',
      promptText: 'Malformed evidence ref outside source range must not be ignored.',
      evidenceRefs: ['message:4 stale suffix'],
      source: {
        chatId: 'malformed-evidence-chat',
        firstMesId: 1,
        lastMesId: 2,
        fingerprint: sourceHash,
        snapshotHash: sourceHash
      },
      freshness: { sourceFingerprint: sourceHash }
    }
  });
}

{
  const chatMismatchMessages = [
    { mesid: 1, role: 'assistant', text: 'Reject wrong chat source.', visible: true },
    { mesid: 2, role: 'user', text: 'Source chat mismatch.', visible: true }
  ];
  const sourceHash = sourceWindowHash(chatMismatchMessages, 1, 2);
  await assertSingleCachedCardUnavailable({
    label: 'source-chat-mismatch-cache',
    userMessage: 'Reject source chat mismatch.',
    snapshot: {
      chatId: 'current-cache-chat',
      chatKey: 'current-cache-chat',
      sceneKey: 'current-cache-scene',
      sceneFingerprint: 'current-cache-scene-fp',
      turnFingerprint: 'current-cache-turn-fp',
      latestMesId: 2,
      messages: chatMismatchMessages
    },
    card: {
      id: 'chat-mismatch-cache-card',
      family: 'Scene Constraints',
      status: 'active',
      promptText: 'Wrong chat cache card must not be reused.',
      evidenceRefs: ['message:2'],
      source: {
        chatId: 'other-cache-chat',
        firstMesId: 1,
        lastMesId: 2,
        fingerprint: sourceHash,
        snapshotHash: sourceHash
      },
      freshness: { sourceFingerprint: sourceHash }
    }
  });
}

{
  const futureRangeMessages = [
    { mesid: 1, role: 'assistant', text: 'Known source start.', visible: true },
    { mesid: 2, role: 'user', text: 'Reject future source range.', visible: true }
  ];
  const sourceHash = sourceWindowHash(futureRangeMessages, 1, 3);
  await assertSingleCachedCardUnavailable({
    label: 'future-source-range-cache',
    userMessage: 'Reject future source range.',
    snapshot: {
      chatId: 'future-cache-chat',
      chatKey: 'future-cache-chat',
      sceneKey: 'future-cache-scene',
      sceneFingerprint: 'future-cache-scene-fp',
      turnFingerprint: 'future-cache-turn-fp',
      latestMesId: 2,
      messages: futureRangeMessages
    },
    card: {
      id: 'future-range-cache-card',
      family: 'Scene Frame',
      status: 'active',
      promptText: 'Future source range must not be reused.',
      evidenceRefs: ['message:2'],
      source: {
        chatId: 'future-cache-chat',
        firstMesId: 1,
        lastMesId: 3,
        fingerprint: sourceHash,
        snapshotHash: sourceHash
      },
      freshness: { sourceFingerprint: sourceHash }
    }
  });
}

{
  const hiddenRangeMessages = [
    { mesid: 1, role: 'assistant', text: 'Visible range start.', visible: true },
    { mesid: 2, role: 'assistant', text: 'Hidden middle source.', visible: false },
    { mesid: 3, role: 'user', text: 'Reject hidden source range.', visible: true }
  ];
  const sourceHash = sourceWindowHash(hiddenRangeMessages, 1, 3);
  await assertSingleCachedCardUnavailable({
    label: 'hidden-source-range-cache',
    userMessage: 'Reject hidden source range.',
    snapshot: {
      chatId: 'hidden-range-chat',
      chatKey: 'hidden-range-chat',
      sceneKey: 'hidden-range-scene',
      sceneFingerprint: 'hidden-range-scene-fp',
      turnFingerprint: 'hidden-range-turn-fp',
      latestMesId: 3,
      messages: hiddenRangeMessages
    },
    card: {
      id: 'hidden-range-cache-card',
      family: 'Scene Constraints',
      status: 'active',
      promptText: 'Hidden source range must not be reused.',
      evidenceRefs: ['message:3'],
      source: {
        chatId: 'hidden-range-chat',
        firstMesId: 1,
        lastMesId: 3,
        fingerprint: sourceHash,
        snapshotHash: sourceHash
      },
      freshness: { sourceFingerprint: sourceHash }
    }
  });
}

{
  const expiredMessages = [
    { mesid: 1, role: 'assistant', text: 'Expired card source.', visible: true },
    { mesid: 2, role: 'user', text: 'Still in source window.', visible: true },
    { mesid: 3, role: 'user', text: 'Reject expired source freshness.', visible: true }
  ];
  const sourceHash = sourceWindowHash(expiredMessages, 1, 2);
  await assertSingleCachedCardUnavailable({
    label: 'expired-cache-card',
    userMessage: 'Reject expired cached card.',
    snapshot: {
      chatId: 'expired-cache-chat',
      chatKey: 'expired-cache-chat',
      sceneKey: 'expired-cache-scene',
      sceneFingerprint: 'expired-cache-scene-fp',
      turnFingerprint: 'expired-cache-turn-fp',
      latestMesId: 3,
      messages: expiredMessages
    },
    card: {
      id: 'expired-cache-card',
      family: 'Scene Frame',
      status: 'active',
      promptText: 'Expired cache card must not be reused.',
      evidenceRefs: ['message:2'],
      source: {
        chatId: 'expired-cache-chat',
        firstMesId: 1,
        lastMesId: 2,
        fingerprint: sourceHash,
        snapshotHash: sourceHash
      },
      freshness: { sourceFingerprint: sourceHash, expiresAfterMesId: 2 }
    }
  });
}

{
  const missingEvidenceMessages = [
    { mesid: 1, role: 'assistant', text: 'Valid source start.', visible: true },
    { mesid: 2, role: 'user', text: 'Reject missing evidence ref.', visible: true }
  ];
  const sourceHash = sourceWindowHash(missingEvidenceMessages, 1, 2);
  await assertSingleCachedCardUnavailable({
    label: 'missing-evidence-cache',
    userMessage: 'Reject missing evidence ref.',
    snapshot: {
      chatId: 'missing-evidence-chat',
      chatKey: 'missing-evidence-chat',
      sceneKey: 'missing-evidence-scene',
      sceneFingerprint: 'missing-evidence-scene-fp',
      turnFingerprint: 'missing-evidence-turn-fp',
      latestMesId: 2,
      messages: missingEvidenceMessages
    },
    card: {
      id: 'missing-evidence-card',
      family: 'Scene Constraints',
      status: 'active',
      promptText: 'Missing evidence ref must not be ignored.',
      evidenceRefs: ['message:4'],
      source: {
        chatId: 'missing-evidence-chat',
        firstMesId: 1,
        lastMesId: 2,
        fingerprint: sourceHash,
        snapshotHash: sourceHash
      },
      freshness: { sourceFingerprint: sourceHash }
    }
  });
}

{
  const unparseableEvidenceMessages = [
    { mesid: 1, role: 'assistant', text: 'Valid source start.', visible: true },
    { mesid: 2, role: 'user', text: 'Reject unparseable evidence refs.', visible: true }
  ];
  const sourceHash = sourceWindowHash(unparseableEvidenceMessages, 1, 2);
  await assertSingleCachedCardUnavailable({
    label: 'unparseable-evidence-cache',
    userMessage: 'Reject unparseable evidence refs.',
    snapshot: {
      chatId: 'unparseable-evidence-chat',
      chatKey: 'unparseable-evidence-chat',
      sceneKey: 'unparseable-evidence-scene',
      sceneFingerprint: 'unparseable-evidence-scene-fp',
      turnFingerprint: 'unparseable-evidence-turn-fp',
      latestMesId: 2,
      messages: unparseableEvidenceMessages
    },
    card: {
      id: 'unparseable-evidence-card',
      family: 'Scene Constraints',
      status: 'active',
      promptText: 'Unparseable evidence ref must not be ignored.',
      evidenceRefs: ['turn:2'],
      source: {
        chatId: 'unparseable-evidence-chat',
        firstMesId: 1,
        lastMesId: 2,
        fingerprint: sourceHash,
        snapshotHash: sourceHash
      },
      freshness: { sourceFingerprint: sourceHash }
    }
  });
}

{
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  await storage.saveSceneCache('hostile-cache-chat', 'hostile-cache-scene', {
    versions: cacheContractVersions({ mode: 'auto', reasonerUse: 'off' }),
    cards: [{
      id: 'Bearer cache-card-token',
      family: 'Scene Frame',
      status: 'active',
      promptText: 'Prompt text raw-host-metadata-should-not-leak with Bearer cache-prompt-token.',
      evidenceRefs: ['message:2 raw-evidence-metadata-should-not-leak Bearer cache-evidence-token'],
      source: {
        chatId: 'hostile-cache-chat',
        firstMesId: 1,
        lastMesId: 2,
        snapshotHash: 'raw-source-metadata-should-not-leak'
      },
      freshness: {
        sourceFingerprint: 'raw-freshness-metadata-should-not-leak'
      }
    }],
    latestHand: {
      handId: 'Bearer cache-hand-token',
      cards: [{ id: 'Bearer cache-card-token' }]
    }
  });
  let arbiterPrompt = '';
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    snapshot: {
      chatId: 'hostile-cache-chat',
      chatKey: 'hostile-cache-chat',
      sceneKey: 'hostile-cache-scene',
      sceneFingerprint: 'hostile-cache-scene-fp',
      turnFingerprint: 'hostile-cache-turn-fp',
      latestMesId: 3,
      messages: [{ mesid: 3, role: 'user', text: 'Do not leak hostile cache metadata.', visible: true }]
    },
    generationRouter: {
      async generate(roleId, request) {
        assertEqual(roleId, 'utilityArbiter', 'hostile cache safety test only calls utility arbiter');
        arbiterPrompt = request.prompt;
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'skip',
            diagnostics: ['hostile-cache-safety']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Hostile cache safety.' });
  assertEqual(result.ok, true, 'hostile cache safety run skips safely');
  const sceneCache = parsePromptJsonSection(arbiterPrompt, 'Scene cache');
  const serializedPrompt = JSON.stringify({ prompt: arbiterPrompt, sceneCache });
  assert(!serializedPrompt.includes('raw-host-metadata-should-not-leak'), 'arbiter cache view omits raw cached prompt text');
  assert(!serializedPrompt.includes('raw-evidence-metadata-should-not-leak'), 'arbiter cache view omits raw cached evidence metadata');
  assert(!serializedPrompt.includes('raw-source-metadata-should-not-leak'), 'arbiter cache view omits raw cached source fingerprint text');
  assert(!serializedPrompt.includes('raw-freshness-metadata-should-not-leak'), 'arbiter cache view omits raw cached freshness fingerprint text');
  assertNoSecretText(serializedPrompt, 'arbiter hostile cache prompt');
  assert(sceneCache.cards.length === 1, 'arbiter cache view keeps valid sanitized card metadata');
  assert(sceneCache.cards[0].source.fingerprint.startsWith('hash:'), 'arbiter cache view hashes source fingerprints');
}

{
  let batchCalled = false;
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        assertEqual(roleId, 'utilityArbiter', 'invalid schema test only asks Utility Arbiter');
        return {
          ok: true,
          data: {
            schema: 'wrong.schema.v1',
            cardJobs: [{ family: 'Open Threads', reason: 'This invalid plan must not run.' }],
            budgets: { targetBriefTokens: 500, maxCards: 6 },
            diagnostics: ['invalid-schema-plan']
          }
        };
      },
      async batch() {
        batchCalled = true;
        return [];
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Invalid schema fallback.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'invalid arbiter schema falls back fail-soft');
  assertEqual(batchCalled, false, 'invalid arbiter schema does not execute provider card jobs');
  assert(view.lastPlan.diagnostics.includes('utility-arbiter-fallback'), 'invalid arbiter schema records fallback diagnostic');
  assert(view.lastHand.cards.some((card) => card.family === 'Scene Frame'), 'invalid arbiter schema uses local fallback scene card');
  assert(!view.lastHand.cards.some((card) => card.family === 'Open Threads'), 'invalid arbiter schema ignores untrusted provider card jobs');
}

{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        return {
          ok: true,
          data: {
            diagnostics: ['missing-schema-plan'],
            authorization: 'Bearer missing-schema-token'
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Missing schema fallback.' });
  const serialized = JSON.stringify({ result, view: runtime.view() });
  assertEqual(result.ok, true, 'missing arbiter schema falls back fail-soft');
  assert(runtime.view().lastPlan.diagnostics.includes('utility-arbiter-fallback'), 'missing arbiter schema records fallback diagnostic');
  assert(!serialized.includes('Bearer missing-schema-token'), 'missing schema fallback does not leak rejected provider fields');
  assertNoSecretText(serialized, 'missing schema fallback');
}

{
  const reuseCacheMessages = [
    { mesid: 2, role: 'user', text: 'Reuse cached card.', visible: true }
  ];
  const reuseCacheSourceHash = sourceWindowHash(reuseCacheMessages, 2, 2);
  const storage = {
    async loadSceneCache() {
      return {
        versions: cacheContractVersions({ mode: 'auto', reasonerUse: 'off' }),
        cards: [{
          id: 'sk-live-card-id',
          family: 'Scene Frame',
          promptText: 'Cached card with Bearer cache-token, sk-cache-runtime, and private-secret must be scrubbed.',
          summary: 'Cached summary with Bearer cache-token.',
          evidenceRefs: ['message:2 sk-cache-runtime'],
          inspectorNotes: 'Cached inspector private-secret',
          emphasis: 'normal',
          source: {
            chatId: 'reuse-cache-chat',
            firstMesId: 2,
            lastMesId: 2,
            fingerprint: reuseCacheSourceHash,
            snapshotHash: reuseCacheSourceHash
          },
          freshness: { sourceFingerprint: reuseCacheSourceHash }
        }]
      };
    },
    async saveSceneCache() {
      throw new Error('reuse-cache should not save scene cache');
    },
    async appendJournal() {
      return {};
    }
  };
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    snapshot: {
      chatId: 'reuse-cache-chat',
      chatKey: 'reuse-cache-chat',
      sceneKey: 'reuse-cache-scene',
      sceneFingerprint: 'reuse-cache-scene-fp',
      turnFingerprint: 'reuse-cache-turn-fp',
      latestMesId: 2,
      messages: reuseCacheMessages
    },
    generationRouter: {
      async generate(roleId, request) {
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'reuse-cache',
            budgets: { targetBriefTokens: 500, maxCards: 4 },
            diagnostics: ['reuse-cache-redaction']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Reuse cached card.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'reuse-cache card run installs');
  assert(
    view.activityHistory.some((event) => event.phase === 'cardProgress'
      && event.detail?.parentStepId === 'utility-card-batch'
      && event.detail?.roleId === 'sceneFrameCard'
      && event.detail?.source === 'cache'
      && event.detail?.state === 'cached'),
    'cache-reused card emits cached child progress'
  );
  assertNoSecretText({ resultHand: result.hand, viewHand: view.lastHand }, 'cached hand cards');
}

{
  const storage = {
    async loadSceneCache() {
      return {
        versions: cacheContractVersions({ mode: 'auto', reasonerUse: 'off' }),
        cards: [{ family: 'Bogus Family', promptText: 'bad cached card' }]
      };
    },
    async saveSceneCache() {
      throw new Error('reuse-cache malformed cache should not save');
    },
    async appendJournal() {
      return {};
    }
  };
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    generationRouter: {
      async generate(roleId, request) {
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'reuse-cache',
            budgets: { targetBriefTokens: 500, maxCards: 4 },
            diagnostics: ['malformed-cache']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Reuse malformed cached card.' });
  assertEqual(result.ok, true, 'malformed reuse-cache does not throw');
  assertEqual(result.skipped, true, 'malformed reuse-cache is treated as unavailable');
  assertEqual(result.reason, 'cache-unavailable', 'malformed reuse-cache returns unavailable reason');
  assertEqual(installed.length, 0, 'malformed reuse-cache does not install prompt');
}

{
  const providerPrompts = [];
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: {
      chatId: 'provider-chat',
      chatKey: 'provider-chat',
      sceneKey: 'provider-scene',
      sceneFingerprint: 'provider-scene-fp',
      turnFingerprint: 'provider-turn-fp',
      latestMesId: 3,
      messages: [
        {
          mesid: 1,
          role: 'assistant',
          text: 'Invisible message with Bearer hidden-token, sk-hidden-runtime, and private-secret must not leak.',
          visible: false,
          metadata: { note: 'hidden metadata should not leak' }
        },
        {
          mesid: 2,
          role: 'user',
          text: 'Visible request with Bearer live-token, sk-live-runtime, and private-secret should be redacted.',
          visible: true,
          hostMetadata: 'metadata should not leak',
          apiKey: 'sk-message-key',
          nested: { authorization: 'Bearer nested-token' }
        },
        {
          mesid: 3,
          role: 'assistant',
          text: 'Visible response is safe.',
          visible: true,
          rawHostPacket: { note: 'metadata should not leak' }
        }
      ]
    },
    generationRouter: {
      async generate(roleId, request) {
        providerPrompts.push({ roleId, prompt: request.prompt });
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            cardJobs: [{ family: 'Open Threads', reason: 'Check the current thread.' }],
            budgets: { targetBriefTokens: 500, maxCards: 4 },
            diagnostics: ['provider-safe-snapshot']
          }
        };
      },
      async batch(requests) {
        providerPrompts.push(...requests.map((request) => ({ roleId: request.roleId, prompt: request.prompt })));
        return requests.map((request) => ({
          ok: true,
          roleId: request.roleId,
          data: {
            schema: 'recursion.card.v1',
            role: request.metadata.role,
            family: request.metadata.family,
            snapshotHash: request.snapshotHash,
            items: [{
              promptText: 'Keep following the visible request.',
              evidenceRefs: ['message:2'],
              tokenEstimate: 10
            }]
          }
        }));
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Provider safe snapshot.' });
  assertEqual(result.ok, true, 'provider-safe snapshot run still installs');
  assert(providerPrompts.length >= 2, 'arbiter and card provider prompts captured');
  const serializedPrompts = JSON.stringify(providerPrompts);
  assert(serializedPrompts.includes('Visible request'), 'provider prompts keep visible message text');
  assert(!serializedPrompts.includes('Invisible message'), 'provider prompts omit invisible message text');
  assert(!serializedPrompts.includes('Bearer live-token'), 'provider prompts redact visible bearer token');
  assert(!serializedPrompts.includes('sk-live-runtime'), 'provider prompts redact visible sk token');
  assert(!serializedPrompts.includes('private-secret'), 'provider prompts redact private secret text');
  assert(!serializedPrompts.includes('Bearer hidden-token'), 'provider prompts omit hidden bearer token');
  assert(!serializedPrompts.includes('sk-hidden-runtime'), 'provider prompts omit hidden sk token');
  assert(!serializedPrompts.includes('metadata should not leak'), 'provider prompts omit arbitrary host metadata values');
  assert(!serializedPrompts.includes('hostMetadata'), 'provider prompts omit arbitrary host metadata keys');
  assert(!serializedPrompts.includes('rawHostPacket'), 'provider prompts omit raw host packet keys');
  const serializedView = JSON.stringify(runtime.view());
  assert(!serializedView.includes('Invisible message'), 'runtime view excludes invisible message text');
  assert(!serializedView.includes('metadata should not leak'), 'runtime view excludes arbitrary host metadata values');
  assert(!serializedView.includes('hostMetadata'), 'runtime view excludes arbitrary host metadata keys');
  assert(!serializedView.includes('rawHostPacket'), 'runtime view excludes raw host packet keys');
  assertNoSecretText(runtime.view(), 'runtime view snapshot');
}

{
  const providerPrompts = [];
  const messages = Array.from({ length: 16 }, (_, index) => ({
    mesid: index,
    role: index % 2 === 0 ? 'assistant' : 'user',
    text: `provider cap message ${index}`,
    visible: true
  }));
  const { runtime } = createRuntimeHarness({
    settings: {
      mode: 'auto',
      reasoningLevel: 'low',
      retention: { providerVisibleMessages: 5 }
    },
    snapshot: {
      chatId: 'provider-cap-chat',
      chatKey: 'provider-cap-chat',
      sceneKey: 'provider-cap-scene',
      sceneFingerprint: 'provider-cap-scene-fp',
      turnFingerprint: 'provider-cap-turn-fp',
      latestMesId: 15,
      messages
    },
    generationRouter: {
      async generate(roleId, request = {}) {
        assertEqual(roleId, 'utilityArbiter', 'provider cap test only needs Arbiter');
        providerPrompts.push(request.prompt);
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'compose-brief',
            cardJobs: [],
            budgets: { targetBriefTokens: 500, maxCards: 4 },
            reasonerDecision: { mode: 'skip', reason: 'provider cap test' },
            diagnostics: ['provider-cap-test']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration();
  assertEqual(result.ok, true, 'provider cap runtime run installs');
  const providerSnapshot = parsePromptJsonSection(providerPrompts[0], 'Snapshot');
  assertDeepEqual(
    providerSnapshot.messages.map((message) => message.mesid),
    [11, 12, 13, 14, 15],
    'provider snapshot honors retention provider cap'
  );
  assertEqual(runtime.view().settings.retention.providerVisibleMessages, 5, 'runtime view exposes retention settings');
  assertEqual(
    Object.prototype.hasOwnProperty.call(runtime.view().settings.diagnostics, 'maxJournalEntries'),
    false,
    'runtime view no longer exposes diagnostics journal cap'
  );
}

{
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: {
      chatId: 'fallback-chat',
      chatKey: 'fallback-chat',
      sceneKey: 'fallback-scene',
      sceneFingerprint: 'fallback-scene-fp',
      turnFingerprint: 'fallback-turn-fp',
      latestMesId: 1,
      messages: [{ mesid: 1, role: 'user', text: 'Fallback visible message.', visible: true }]
    },
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push(roleId);
        throw new Error('arbiter unavailable');
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Fallback plan.' });
  const view = runtime.view();
  const expectedSnapshotHash = hashJson({
    ...view.lastSnapshot,
    messages: view.lastSnapshot.messages.map((message) => ({
      ...message,
      textHash: hashJson(message.text)
    }))
  });
  assertEqual(result.ok, true, 'arbiter exception fails soft without throwing');
  assertEqual(result.skipped, true, 'arbiter exception skips injection without valid cache');
  assertEqual(result.reason, 'utility-unavailable', 'arbiter exception returns Utility unavailable reason');
  assertEqual(routerCalls.length, 1, 'arbiter attempted once');
  assert(view.lastPlan.diagnostics.includes('utility-unavailable'), 'Utility unavailable diagnostic recorded');
  assert(!view.lastPlan.diagnostics.includes('local-fallback-plan'), 'transport failure does not use local fallback diagnostic');
  assertEqual(view.lastPlan.snapshotHash, expectedSnapshotHash, 'fallback plan uses normalized snapshot hash');
  assertEqual(view.lastPlan.source.snapshotHash, expectedSnapshotHash, 'fallback source stores normalized snapshot hash');
  assertEqual(view.lastPlan.source.userMessageHash, hashJson('Fallback plan.'), 'fallback source stores user message hash separately');
  assertEqual(view.lastPlan.source.catalogHash, hashJson(CARD_CATALOG), 'fallback source stores catalog hash separately');
  assertEqual(view.lastHand.cards.length, 0, 'transport failure without cache selects no hand');
}

{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'manual', reasonerUse: 'off' },
    snapshot: {
      messages: null
    }
  });
  const result = await runtime.prepareForGeneration();
  const view = runtime.view();
  assertEqual(result.ok, true, 'missing snapshot fields still prepares');
  assertEqual(view.lastSnapshot.chatId, 'chat', 'missing chat id normalized');
  assertEqual(view.lastSnapshot.chatKey, 'chat', 'missing chat key normalized');
  assertEqual(view.lastSnapshot.sceneKey, 'scene', 'missing scene key normalized');
  assertEqual(view.lastSnapshot.latestMesId, 0, 'missing latest message id normalized');
  assertDeepEqual(view.lastSnapshot.messages, [], 'missing messages normalized to empty array');
  assertEqual(view.lastPacket.chatId, 'chat', 'packet gets normalized chat id');
  assertEqual(view.activeRunId, null, 'active run cleared after normalized manual');
}

{
  const activity = {
    start() {
      throw new Error('start observer failed');
    },
    stage() {
      throw new Error('stage observer failed');
    },
    settle() {
      throw new Error('settle observer failed');
    },
    clear() {
      throw new Error('clear observer failed');
    },
    current() {
      return { phase: 'custom', label: 'observer failed safely' };
    }
  };
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    activity
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Activity throws.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'throwing activity reporter does not crash runtime');
  assertEqual(view.activity.label, 'observer failed safely', 'view still reads activity best-effort');
  assertEqual(view.activeRunId, null, 'active run cleared when activity throws');
}

{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => {
      throw new Error('snapshot failed with Bearer crash-token, sk-crash-runtime, and private-secret');
    }
  });
  let threw = false;
  let caughtError = null;
  try {
    await runtime.prepareForGeneration({ userMessage: 'Crash safely.' });
  } catch (error) {
    threw = true;
    caughtError = error;
  }
  assertEqual(threw, true, 'runtime failure still throws to caller');
  assertNoSecretText(caughtError?.message || caughtError, 'runtime thrown error');
  assertNoSecretText(runtime.view().activity.detail, 'runtime failure activity detail');
}

{
  let releaseFirstLoad;
  const storageOps = [];
  const storage = {
    async loadSceneCache(chatKey) {
      storageOps.push(`load:${chatKey}`);
      if (chatKey === 'run-a') {
        await new Promise((resolve) => {
          releaseFirstLoad = resolve;
        });
      }
      return null;
    },
    async saveSceneCache(chatKey) {
      storageOps.push(`save:${chatKey}`);
      return {};
    },
    async appendJournal(chatKey) {
      storageOps.push(`journal:${chatKey}`);
      return {};
    }
  };
  let snapshotCalls = 0;
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    snapshot: () => {
      snapshotCalls += 1;
      if (snapshotCalls === 1) {
        return {
          chatId: 'run-a',
          chatKey: 'run-a',
          sceneKey: 'scene-a',
          sceneFingerprint: 'scene-a-fp',
          turnFingerprint: 'turn-a-fp',
          latestMesId: 1,
          messages: [{ mesid: 1, role: 'user', text: 'Stale first run text.', visible: true }]
        };
      }
      return {
        chatId: 'run-b',
        chatKey: 'run-b',
        sceneKey: 'scene-b',
        sceneFingerprint: 'scene-b-fp',
        turnFingerprint: 'turn-b-fp',
        latestMesId: 2,
        messages: [{ mesid: 2, role: 'user', text: 'Fresh second run text.', visible: true }]
      };
    }
  });
  const first = runtime.prepareForGeneration({ userMessage: 'Stale first run text.' });
  await waitUntil(() => typeof releaseFirstLoad === 'function', 'first run did not reach scene cache wait');
  const second = await runtime.prepareForGeneration({ userMessage: 'Fresh second run text.' });
  assertEqual(second.ok, true, 'newer run completes while older run is blocked');
  assertEqual(installed.length, 1, 'newer run installs while older run remains blocked');
  assert(JSON.stringify(installed[0]).includes('Fresh second run text.'), 'newer installed packet uses second snapshot');
  releaseFirstLoad();
  const firstResult = await first;
  assertEqual(firstResult.superseded, true, 'older run reports superseded after newer run completes');
  assertEqual(installed.length, 1, 'older run does not install after newer run starts');
  const view = runtime.view();
  const serializedView = JSON.stringify(view);
  assertEqual(view.lastSnapshot.chatKey, 'run-b', 'older run does not overwrite last snapshot');
  assert(serializedView.includes('Fresh second run text.'), 'view keeps newer run prompt state');
  assert(!serializedView.includes('Stale first run text.'), 'older run does not overwrite prompt packet');
  assert(!storageOps.includes('save:run-a'), 'older run does not save stale scene cache');
  assert(!storageOps.includes('journal:run-a'), 'older run does not append stale journal');
}

{
  let releaseFirstSave;
  let firstSaveStarted = false;
  let snapshotCalls = 0;
  const sideEffects = [];
  const storage = {
    async loadSceneCache() {
      return null;
    },
    async saveSceneCache(chatKey) {
      if (!firstSaveStarted) {
        firstSaveStarted = true;
        await new Promise((resolve) => {
          releaseFirstSave = () => {
            sideEffects.push(`save:${chatKey}`);
            resolve();
          };
        });
        return {};
      }
      sideEffects.push(`save:${chatKey}`);
      return {};
    },
    async appendJournal() {
      return {};
    }
  };
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    snapshot: () => {
      snapshotCalls += 1;
      const snapshotRun = snapshotCalls <= 2 ? 1 : 2;
      return {
        chatId: `save-run-${snapshotRun}`,
        chatKey: `save-run-${snapshotRun}`,
        sceneKey: `save-scene-${snapshotRun}`,
        sceneFingerprint: `save-scene-${snapshotRun}`,
        turnFingerprint: `save-turn-${snapshotRun}`,
        latestMesId: snapshotRun,
        messages: [{ mesid: snapshotRun, role: 'user', text: snapshotRun === 1 ? 'Older save packet.' : 'Newer save packet.', visible: true }]
      };
    }
  });
  const first = runtime.prepareForGeneration({ userMessage: 'Older save packet.' });
  await waitUntil(() => typeof releaseFirstSave === 'function', 'first run did not enter scene cache save');
  const second = runtime.prepareForGeneration({ userMessage: 'Newer save packet.' });
  await Promise.resolve();
  assertEqual(snapshotCalls, 2, 'newer run waits for in-flight scene cache save before snapshot');
  assertEqual(sideEffects.length, 0, 'blocked first save has not committed yet');
  releaseFirstSave();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert(firstResult.ok || firstResult.superseded, 'first save run either completes or is superseded after save commits');
  assertEqual(secondResult.ok, true, 'queued newer run completes after cache save');
  assertDeepEqual(sideEffects, ['save:save-run-1', 'save:save-run-2', 'save:save-run-2'], 'scene cache saves commit in run order, including final prompt-packet hash write');
}

{
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  const arbiterMessages = [
    { mesid: 1, role: 'assistant', text: 'The continuity risk was established.', visible: true },
    { mesid: 2, role: 'user', text: 'Keep only the risk that matters.', visible: true },
    { mesid: 3, role: 'user', text: 'Use only the Arbiter-selected card.', visible: true }
  ];
  const arbiterSourceHash = sourceWindowHash(arbiterMessages, 1, 2);
  await storage.saveSceneCache('arbiter-chat', 'arbiter-scene', {
    versions: cacheContractVersions({ mode: 'auto', reasonerUse: 'off' }),
    cards: [
      {
        id: 'arbiter-keep',
        family: 'Scene Constraints',
        status: 'active',
        promptText: 'The only selected continuity risk should remain active.',
        summary: 'Keep continuity',
        tokenEstimate: 20,
        evidenceRefs: ['message:2'],
        source: {
          chatId: 'arbiter-chat',
          firstMesId: 1,
          lastMesId: 2,
          fingerprint: arbiterSourceHash,
          snapshotHash: arbiterSourceHash
        },
        freshness: { sourceFingerprint: arbiterSourceHash }
      },
      {
        id: 'arbiter-stow',
        family: 'Scene Frame',
        status: 'active',
        promptText: 'This card should be stowed by the Arbiter.',
        summary: 'Stow scene',
        tokenEstimate: 20,
        evidenceRefs: ['message:2'],
        source: {
          chatId: 'arbiter-chat',
          firstMesId: 1,
          lastMesId: 2,
          fingerprint: arbiterSourceHash,
          snapshotHash: arbiterSourceHash
        },
        freshness: { sourceFingerprint: arbiterSourceHash }
      }
    ]
  });
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    snapshot: {
      chatId: 'arbiter-chat',
      chatKey: 'arbiter-chat',
      sceneKey: 'arbiter-scene',
      sceneFingerprint: 'arbiter-scene-fp',
      turnFingerprint: 'arbiter-turn-fp',
      latestMesId: 3,
      messages: arbiterMessages
    },
    generationRouter: {
      async generate(roleId, request) {
        assertEqual(roleId, 'utilityArbiter', 'arbiter lifecycle regression only calls utility arbiter');
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'reuse-cache',
            lifecycle: [
              { action: 'select', cardId: 'arbiter-keep', reason: 'still important' },
              { action: 'stow', cardId: 'arbiter-stow', reason: 'not needed this turn' }
            ],
            budgets: { targetBriefTokens: 700, maxCards: 6 },
            diagnostics: ['arbiter-lifecycle-regression']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Use only the Arbiter-selected card.' });
  assertEqual(result.ok, true, 'arbiter lifecycle run installs');
  assertDeepEqual(runtime.view().lastHand.cards.map((card) => card.id), ['arbiter-keep'], 'turn hand honors Arbiter select/stow lifecycle');
  const updated = await storage.loadSceneCache('arbiter-chat', 'arbiter-scene');
  assertEqual(updated.cards.find((card) => card.id === 'arbiter-stow')?.status, 'stowed', 'scene deck persists Arbiter stow decision');
}

{
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  await storage.saveSceneCache('hard-shift-chat', 'hard-shift-original', {
    versions: cacheContractVersions({ mode: 'auto', reasonerUse: 'off' }),
    cards: [{
      id: 'old-scene-card',
      family: 'Scene Frame',
      status: 'active',
      promptText: 'Original scene cache should only inform planning.',
      summary: 'Original scene',
      source: { chatId: 'hard-shift-chat', firstMesId: 1, lastMesId: 2, snapshotHash: 'old-source' }
    }]
  });
  const snapshot = {
    chatId: 'hard-shift-chat',
    chatKey: 'hard-shift-chat',
    sceneKey: 'hard-shift-original',
    sceneFingerprint: 'hard-shift-original-fp',
    turnFingerprint: 'hard-shift-turn-fp',
    latestMesId: 3,
    messages: [{ mesid: 3, role: 'user', text: 'A new scene begins elsewhere.', visible: true }]
  };
  const shiftedFingerprint = hashJson({
    previousSceneFingerprint: snapshot.sceneFingerprint,
    hardShiftAtMesId: snapshot.latestMesId,
    turnFingerprint: snapshot.turnFingerprint
  });
  const shiftedSceneKey = `${snapshot.chatKey}-${shiftedFingerprint}`;
  const shiftedSourceHash = sourceWindowHash(snapshot.messages, 3, 3);
  await storage.saveSceneCache('hard-shift-chat', shiftedSceneKey, {
    versions: cacheContractVersions({ mode: 'auto', reasonerUse: 'off' }),
    cards: [{
      id: 'new-scene-card',
      family: 'Scene Constraints',
      status: 'active',
      promptText: 'New scene cache should remain available after hard shift.',
      summary: 'New scene continuity',
      evidenceRefs: ['message:3'],
      source: {
        chatId: 'hard-shift-chat',
        firstMesId: 3,
        lastMesId: 3,
        fingerprint: shiftedSourceHash,
        snapshotHash: shiftedSourceHash
      },
      freshness: { sourceFingerprint: shiftedSourceHash }
    }]
  });
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    snapshot,
    generationRouter: {
      async generate(roleId, request) {
        assertEqual(roleId, 'utilityArbiter', 'hard-shift lifecycle regression only calls utility arbiter');
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'compose-brief',
            sceneStatus: 'hard-shift',
            lifecycle: [{ action: 'select', cardId: 'old-scene-card', reason: 'selected from original cache before hard shift' }],
            budgets: { targetBriefTokens: 700, maxCards: 6 },
            diagnostics: ['hard-shift-lifecycle-regression']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'A new scene begins elsewhere.' });
  assertEqual(result.ok, true, 'hard-shift lifecycle run installs');
  assertDeepEqual(runtime.view().lastHand.cards.map((card) => card.id), ['new-scene-card'], 'hard-shift cache survives stale pre-shift lifecycle selection');
  const updated = await storage.loadSceneCache('hard-shift-chat', shiftedSceneKey);
  assertEqual(updated.cards.find((card) => card.id === 'new-scene-card')?.status, 'active', 'hard-shift target cache card remains active');
}

{
  const mixedCacheMessages = [
    { mesid: 2, role: 'user', text: 'Use valid cache despite rejected selection.', visible: true }
  ];
  const mixedCacheSourceHash = sourceWindowHash(mixedCacheMessages, 2, 2);
  const storage = {
    async loadSceneCache() {
      return {
        versions: cacheContractVersions({ mode: 'auto', reasonerUse: 'off' }),
        cards: [
          { id: 'rejected-selected', family: 'Bogus Family', promptText: 'invalid selected card' },
          {
            id: 'valid-cache-card',
            family: 'Scene Frame',
            status: 'active',
            promptText: 'Valid cache card should not be stowed by rejected-card lifecycle.',
            summary: 'Valid cache card',
            evidenceRefs: ['message:2'],
            source: {
              chatId: 'mixed-cache-chat',
              firstMesId: 2,
              lastMesId: 2,
              fingerprint: mixedCacheSourceHash,
              snapshotHash: mixedCacheSourceHash
            },
            freshness: { sourceFingerprint: mixedCacheSourceHash }
          }
        ]
      };
    },
    async saveSceneCache() {
      return {};
    },
    async appendJournal() {
      return {};
    }
  };
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    snapshot: {
      chatId: 'mixed-cache-chat',
      chatKey: 'mixed-cache-chat',
      sceneKey: 'mixed-cache-scene',
      sceneFingerprint: 'mixed-cache-scene-fp',
      turnFingerprint: 'mixed-cache-turn-fp',
      latestMesId: 2,
      messages: mixedCacheMessages
    },
    generationRouter: {
      async generate(roleId, request) {
        assertEqual(roleId, 'utilityArbiter', 'mixed cache lifecycle regression only calls utility arbiter');
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'compose-brief',
            lifecycle: [{ action: 'select', cardId: 'rejected-selected', reason: 'malformed card was selected before validation' }],
            budgets: { targetBriefTokens: 700, maxCards: 6 },
            diagnostics: ['mixed-cache-lifecycle-regression']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Use valid cache despite rejected selection.' });
  assertEqual(result.ok, true, 'mixed cache lifecycle run installs');
  assertDeepEqual(runtime.view().lastHand.cards.map((card) => card.id), ['valid-cache-card'], 'valid cache card survives lifecycle for rejected card id');
}

{
  let utilityCalls = 0;
  let firstGenerateStarted = false;
  let firstAbortObserved = false;
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request = {}) {
        assertEqual(roleId, 'utilityArbiter', 'provider supersession test only calls utility arbiter');
        utilityCalls += 1;
        if (utilityCalls === 1) {
          firstGenerateStarted = true;
          if (request.signal) {
            request.signal.addEventListener('abort', () => {
              firstAbortObserved = true;
            }, { once: true });
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
          return {
            ok: false,
            error: { code: 'FIRST_NOT_ABORTED', message: 'first provider call was not aborted' }
          };
        }
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'skip',
            diagnostics: ['newer-run-superseded-provider']
          }
        };
      }
    }
  });
  const first = runtime.prepareForGeneration({ userMessage: 'first provider call' });
  await waitUntil(() => firstGenerateStarted, 'first run did not enter provider call');
  const second = await runtime.prepareForGeneration({ userMessage: 'second provider call' });
  assertEqual(second.ok, true, 'newer run completes while older provider call is blocked');
  const firstResult = await first;
  assertEqual(firstResult.superseded, true, 'older provider run reports superseded');
  assertEqual(firstAbortObserved, true, 'blocked provider call observes abort when superseded');
}

{
  let releaseArbiter;
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request = {}) {
        assertEqual(roleId, 'utilityArbiter', 'dispose regression only needs utility arbiter');
        await new Promise((resolve) => {
          releaseArbiter = resolve;
        });
        assertEqual(request.signal?.aborted, true, 'dispose aborts in-flight provider signal');
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'compose-brief',
            diagnostics: ['dispose-regression']
          }
        };
      }
    }
  });
  const pending = runtime.prepareForGeneration({ userMessage: 'Dispose before install.' });
  await waitUntil(() => typeof releaseArbiter === 'function', 'dispose run did not enter arbiter');
  assertEqual(typeof runtime.dispose, 'function', 'runtime exposes dispose for extension teardown');
  await runtime.dispose();
  releaseArbiter();
  const result = await pending;
  assertEqual(result.superseded, true, 'disposed run reports superseded');
  assertEqual(installed.length, 0, 'disposed run cannot install a prompt');
  assertEqual(runtime.view().activeRunId, null, 'dispose clears active run id');
}

{
  let releaseArbiter;
  const { runtime, calls } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request = {}) {
        assertEqual(roleId, 'utilityArbiter', 'chat-change regression only needs utility arbiter');
        await new Promise((resolve) => {
          releaseArbiter = resolve;
        });
        assertEqual(request.signal?.aborted, true, 'chat change aborts in-flight provider signal');
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'compose-brief',
            diagnostics: ['chat-change-regression']
          }
        };
      }
    }
  });
  const pending = runtime.prepareForGeneration({ userMessage: 'Turn changes before install.' });
  await waitUntil(() => typeof releaseArbiter === 'function', 'chat-change run did not enter arbiter');
  assertEqual(typeof runtime.handleChatChanged, 'function', 'runtime exposes chat-change cleanup');
  const chatChange = runtime.handleChatChanged();
  releaseArbiter();
  const [chatChangeResult, pendingResult] = await Promise.all([chatChange, pending]);
  assertEqual(pendingResult.superseded, true, 'chat change supersedes in-flight generation preparation');
  assertEqual(chatChangeResult.ok, true, 'chat change cleanup succeeds');
  assertEqual(calls.clear, 1, 'chat change clears host prompt');
  const view = runtime.view();
  assertEqual(view.activeRunId, null, 'chat change clears active run id');
  assertEqual(view.lastPacket, null, 'chat change clears in-memory prompt packet');
  assertEqual(view.lastHand.cards.length, 0, 'chat change clears in-memory hand');
  assertEqual(view.lastPlan, null, 'chat change clears in-memory plan');
  assertEqual(view.lastSnapshot, null, 'chat change clears in-memory snapshot');
  assertEqual(view.activity.label, 'Chat changed. Recursion prompt cleared.', 'chat change surfaces prompt cleanup');
}

{
  const { runtime, calls, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' }
  });
  const setup = await runtime.prepareForGeneration({ userMessage: 'Prepare prompt before chat change.' });
  assertEqual(setup.ok, true, 'chat-change setup prepares generation');
  const setupSnapshot = runtime.view().lastSnapshot;
  const result = await runtime.handleChatChanged();
  assertEqual(result.ok, true, 'chat change cleanup returns ok');
  assertEqual(calls.clear, 1, 'chat change clears installed prompt');
  const cache = await storage.loadSceneCache(setupSnapshot.chatKey, setupSnapshot.sceneKey);
  assertEqual(cache.cacheState, 'stale', 'chat change marks previous active scene cache stale');
  assertEqual(cache.invalidation.reason, 'chat-changed', 'chat change records cache invalidation reason');
  const journal = await storage.loadRunJournal(setupSnapshot.chatKey);
  assert(journal.entries.some((entry) => entry.event === 'prompt.cleared' && entry.details?.reason === 'chat-changed'), 'chat change records prompt clear journal');
  assertEqual(runtime.view().lastSnapshot, null, 'chat change clears previous snapshot after journaling');
}

{
  const { runtime, calls, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' }
  });
  const prepared = await runtime.prepareForGeneration({
    userMessage: 'Stop after install.',
    hostGeneration: true
  });
  assertEqual(prepared.ok, true, 'host-stop preservation setup installs prompt');
  const before = runtime.view();
  const setupSnapshot = before.lastSnapshot;
  const beforePacketId = before.lastPacket?.packetId;
  const beforeHandId = before.lastHand?.handId;
  assert(beforePacketId, 'host-stop preservation setup has prompt packet');
  assert(beforeHandId, 'host-stop preservation setup has hand');
  const stopped = await runtime.handleHostGenerationStopped({
    eventName: 'generation_stopped',
    messageId: 42,
    source: 'host-runtime',
    reason: 'generation-aborted',
    origin: 'unknown-listener',
    payloadType: 'object',
    payloadKeys: ['mesid', 'origin', 'reason', 'source']
  });
  assertEqual(stopped.ok, true, 'post-install host generation stop cleanup succeeds');
  assertEqual(calls.clear, 1, 'post-install host generation stop clears host prompt');
  const after = runtime.view();
  assertEqual(after.lastPacket?.packetId, beforePacketId, 'host generation stop preserves in-memory prompt packet for Last Brief');
  assertEqual(after.lastHand?.handId, beforeHandId, 'host generation stop preserves in-memory hand for Last Brief');
  assert(after.lastHand.cards.length > 0, 'host generation stop keeps selected cards visible');
  assertEqual(after.lastPlan?.schema, UTILITY_ARBITER_SCHEMA, 'host generation stop preserves plan diagnostics for inspection');
  assert(after.lastSnapshot, 'host generation stop preserves last snapshot for diagnostics');
  const journal = await storage.loadRunJournal(setupSnapshot.chatKey);
  const stopEntry = journal.entries.find((entry) => entry.event === 'host.generation_stopped');
  assert(stopEntry, 'unexpected host generation stop records a dedicated journal entry');
  assertEqual(stopEntry.severity, 'warn', 'unexpected host generation stop is warning severity');
  assertEqual(stopEntry.details.recursionRequested, false, 'host event is distinguished from an explicit Recursion stop');
  assertEqual(stopEntry.details.hostGenerationActive, true, 'stop journal captures host generation state before cleanup');
  assertEqual(stopEntry.details.enhancementPending, false, 'stop journal captures pending Enhancement state before cleanup');
  assertEqual(stopEntry.details.eventName, 'generation_stopped', 'stop journal records normalized event name');
  assertEqual(stopEntry.details.source, 'host-runtime', 'stop journal records normalized source');
  assertEqual(stopEntry.details.reason, 'generation-aborted', 'stop journal records normalized reason');
  assertEqual(stopEntry.details.origin, 'unknown-listener', 'stop journal records normalized origin');
  assertDeepEqual(stopEntry.details.payloadKeys, ['mesid', 'origin', 'reason', 'source'], 'stop journal records raw payload keys');
}

{
  let releaseArbiter;
  const hostStopCalls = [];
  const { runtime, calls, installed, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    hostGeneration: {
      async stop(details = {}) {
        hostStopCalls.push(details);
        return { ok: true, stopped: true, eventEmitted: false, source: 'test-host-stop' };
      }
    },
    generationRouter: {
      async generate(roleId, request = {}) {
        assertEqual(roleId, 'utilityArbiter', 'host-stop regression only needs utility arbiter');
        await new Promise((resolve) => {
          releaseArbiter = resolve;
        });
        assertEqual(request.signal?.aborted, true, 'host generation stop aborts in-flight provider signal');
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'compose-brief',
            diagnostics: ['host-stop-regression']
          }
        };
      }
    }
  });
  const pending = runtime.prepareForGeneration({ userMessage: 'Stop before install.', hostGeneration: true });
  await waitUntil(() => typeof releaseArbiter === 'function', 'host-stop run did not enter arbiter');
  const stopSnapshot = runtime.view().lastSnapshot;
  assertEqual(runtime.view().hostGenerationActive, true, 'runtime tracks host generation while interceptor-owned generation is active');
  assertEqual(typeof runtime.stopGeneration, 'function', 'runtime exposes unified stop action');
  const stopped = runtime.stopGeneration({ source: 'recursion-ui' });
  releaseArbiter();
  const [stopResult, pendingResult] = await Promise.all([stopped, pending]);
  assertEqual(pendingResult.superseded, true, 'host generation stop supersedes in-flight generation preparation');
  assertEqual(stopResult.ok, true, 'unified stop cleanup succeeds');
  assertEqual(stopResult.hostStop.ok, true, 'unified stop returns host stop result');
  assertEqual(hostStopCalls.length, 1, 'unified stop calls host generation stop once');
  assertEqual(hostStopCalls[0].source, 'recursion-ui', 'unified stop passes UI source to host generation stop');
  assertEqual(calls.clear, 1, 'host generation stop clears host prompt');
  assertEqual(installed.length, 0, 'host generation stop prevents prompt install');
  const view = runtime.view();
  assertEqual(view.hostGenerationActive, false, 'unified stop clears host generation active state');
  assertEqual(view.activeRunId, null, 'host generation stop clears active run id');
  assertEqual(view.lastPacket, null, 'host generation stop clears in-memory prompt packet');
  assertEqual(view.lastHand.cards.length, 0, 'host generation stop clears in-memory hand');
  assertEqual(view.lastPlan, null, 'host generation stop clears in-memory plan');
  assert(view.lastSnapshot, 'host generation stop preserves last snapshot for cancellation diagnostics');
  assertEqual(view.activity.label, 'Generation canceled. Recursion prompt cleared.', 'host generation stop surfaces canceled cleanup');
  assertEqual(view.activity.outcome, 'skipped', 'host generation stop activity is neutral skipped outcome');
  const journal = await storage.loadRunJournal(stopSnapshot.chatKey);
  const stopEntry = journal.entries.find((entry) => entry.event === 'host.generation_stopped');
  assert(stopEntry, 'explicit Recursion stop records a dedicated journal entry');
  assertEqual(stopEntry.severity, 'info', 'explicit Recursion stop is informational');
  assertEqual(stopEntry.details.recursionRequested, true, 'explicit Recursion stop records its origin');
  assertEqual(stopEntry.details.hostGenerationActive, true, 'explicit stop captures host generation state before cleanup');
}

{
  let releaseClear;
  const { runtime, calls } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    hostPrompt: {
      clear: () => new Promise((resolve) => {
        releaseClear = () => resolve({ ok: true, cleared: true });
      })
    }
  });
  const firstStop = runtime.handleHostGenerationStopped({ eventName: 'generation_stopped' });
  const secondStop = runtime.handleHostGenerationStopped({ eventName: 'generation_stopped' });
  await waitUntil(() => typeof releaseClear === 'function', 'host stop cleanup did not start prompt clear');
  releaseClear();
  const [firstResult, secondResult] = await Promise.all([firstStop, secondStop]);
  assertEqual(firstResult.ok, true, 'first duplicate host stop cleanup succeeds');
  assertEqual(secondResult.ok, true, 'second duplicate host stop cleanup shares cleanup result');
  assertEqual(calls.clear, 1, 'concurrent duplicate host stop events share one prompt clear');
}

{
  const { runtime, calls, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' }
  });
  const setup = await runtime.prepareForGeneration({ userMessage: 'Prepare prompt before Stop.' });
  assertEqual(setup.ok, true, 'host-stop setup prepares generation');
  const setupSnapshot = runtime.view().lastSnapshot;
  const result = await runtime.handleHostGenerationStopped({ eventName: 'generation_stopped' });
  assertEqual(result.ok, true, 'host generation stop cleanup returns ok');
  assertEqual(calls.clear, 1, 'host generation stop clears installed prompt');
  const cache = await storage.loadSceneCache(setupSnapshot.chatKey, setupSnapshot.sceneKey);
  assertEqual(cache.cacheState, 'active', 'host generation stop preserves previous active scene cache');
  assertEqual(cache.invalidation, undefined, 'host generation stop does not invent cache invalidation');
  const journal = await storage.loadRunJournal(setupSnapshot.chatKey);
  assert(journal.entries.some((entry) => entry.event === 'prompt.cleared' && entry.details?.reason === 'host-generation-stopped'), 'host generation stop records prompt clear journal');
  assertEqual(runtime.view().lastSnapshot?.chatKey, setupSnapshot.chatKey, 'host generation stop preserves previous snapshot after journaling');
  assert(runtime.view().lastPacket, 'host generation stop preserves prompt packet after journaling');
  assert(runtime.view().lastHand.cards.length > 0, 'host generation stop preserves selected hand after journaling');
}

{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' }
  });
  assertEqual(runtime.view().hostGenerationActive, false, 'runtime starts with host generation inactive');
  const setup = await runtime.prepareForGeneration({ userMessage: 'Prepare host generation state.', hostGeneration: true });
  assertEqual(setup.ok, true, 'host generation state setup prepares prompt');
  assertEqual(runtime.view().hostGenerationActive, true, 'runtime keeps stop affordance active after prompt preparation until host settles');
  assertEqual(typeof runtime.handleHostGenerationEnded, 'function', 'runtime exposes host generation end handler');
  runtime.handleHostGenerationEnded({ eventName: 'generation_ended' });
  assertEqual(runtime.view().hostGenerationActive, false, 'host generation end clears stop affordance state');
}

{
  let releaseArbiter;
  const { runtime, calls } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request = {}) {
        assertEqual(roleId, 'utilityArbiter', 'source-change regression only needs utility arbiter');
        await new Promise((resolve) => {
          releaseArbiter = resolve;
        });
        assertEqual(request.signal?.aborted, true, 'source change aborts in-flight provider signal');
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'compose-brief',
            diagnostics: ['source-change-regression']
          }
        };
      }
    }
  });
  const pending = runtime.prepareForGeneration({ userMessage: 'Message changes before install.' });
  await waitUntil(() => typeof releaseArbiter === 'function', 'source-change run did not enter arbiter');
  assertEqual(typeof runtime.handleSourceChanged, 'function', 'runtime exposes source-change cleanup');
  const sourceChange = runtime.handleSourceChanged({ eventName: 'message_updated', messageId: 2 });
  releaseArbiter();
  const [sourceChangeResult, pendingResult] = await Promise.all([sourceChange, pending]);
  assertEqual(pendingResult.superseded, true, 'source change supersedes in-flight generation preparation');
  assertEqual(sourceChangeResult.ok, true, 'source change cleanup succeeds');
  assertEqual(calls.clear, 1, 'source change clears host prompt');
  const view = runtime.view();
  assertEqual(view.activeRunId, null, 'source change clears active run id');
  assertEqual(view.lastPacket, null, 'source change clears in-memory prompt packet');
  assertEqual(view.lastHand.cards.length, 0, 'source change clears in-memory hand');
  assertEqual(view.lastPlan, null, 'source change clears in-memory plan');
  assertEqual(view.lastSnapshot, null, 'source change clears in-memory snapshot');
  assertEqual(view.activity.label, 'Source messages changed. Recursion prompt cleared.', 'source change surfaces prompt cleanup');
}

{
  const { runtime, calls, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' }
  });
  const setup = await runtime.prepareForGeneration({ userMessage: 'Prepare prompt before source edit.' });
  assertEqual(setup.ok, true, 'source-change setup prepares generation');
  const setupSnapshot = runtime.view().lastSnapshot;
  const result = await runtime.handleSourceChanged({ eventName: 'message_deleted', messageId: 2 });
  assertEqual(result.ok, true, 'source change cleanup returns ok');
  assertEqual(calls.clear, 1, 'source change clears installed prompt');
  const cache = await storage.loadSceneCache(setupSnapshot.chatKey, setupSnapshot.sceneKey);
  assertEqual(cache.cacheState, 'stale', 'source change marks previous active scene cache stale');
  assertEqual(cache.invalidation.reason, 'source-changed', 'source change records cache invalidation reason');
  assertEqual(cache.invalidation.details.eventName, 'message_deleted', 'source change stores safe event name');
  assertEqual(cache.invalidation.details.messageId, 2, 'source change stores safe message id');
  const journal = await storage.loadRunJournal(setupSnapshot.chatKey);
  assert(journal.entries.some((entry) => entry.event === 'prompt.cleared' && entry.details?.reason === 'source-changed'), 'source change records prompt clear journal');
  assertEqual(runtime.view().lastSnapshot, null, 'source change clears previous snapshot after journaling');
}

{
  let releaseArbiter;
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request = {}) {
        assertEqual(roleId, 'utilityArbiter', 'power-toggle regression only needs utility arbiter');
        await new Promise((resolve) => {
          releaseArbiter = resolve;
        });
        assertEqual(request.signal?.aborted, true, 'switching power off aborts in-flight provider signal');
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'compose-brief',
            diagnostics: ['power-toggle-regression']
          }
        };
      }
    }
  });
  const pending = runtime.prepareForGeneration({ userMessage: 'Turn off before install.' });
  await waitUntil(() => typeof releaseArbiter === 'function', 'power-toggle run did not enter arbiter');
  const offUpdate = runtime.updateSettings({ enabled: false });
  releaseArbiter();
  const result = await pending;
  assertEqual(result.superseded, true, 'power toggle change supersedes in-flight generation preparation');
  assertEqual(installed.length, 0, 'power toggle change prevents stale prompt install');
  assertEqual(runtime.view().activeRunId, null, 'power toggle change clears active run id');
  await offUpdate;
}

{
  let releaseFirstClear;
  let firstClearStarted = false;
  let snapshotCalls = 0;
  const sideEffects = [];
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => {
      snapshotCalls += 1;
      const snapshotRun = snapshotCalls === 1 ? 1 : 2;
      return {
        chatId: `clear-run-${snapshotRun}`,
        chatKey: `clear-run-${snapshotRun}`,
        sceneKey: `clear-scene-${snapshotRun}`,
        sceneFingerprint: `clear-scene-${snapshotRun}`,
        turnFingerprint: `clear-turn-${snapshotRun}`,
        latestMesId: snapshotRun,
        messages: [{ mesid: snapshotRun, role: 'user', text: snapshotRun === 1 ? 'Older clear packet.' : 'Newer install after clear.', visible: true }]
      };
    },
    hostPrompt: {
      async clear() {
        if (!firstClearStarted) {
          firstClearStarted = true;
          await new Promise((resolve) => {
            releaseFirstClear = () => {
              sideEffects.push('clear:first');
              resolve();
            };
          });
          return { ok: true, cleared: true };
        }
        sideEffects.push('clear:next');
        return { ok: true, cleared: true };
      },
      async install(packet) {
        sideEffects.push(`install:${JSON.stringify(packet).includes('Newer install after clear.') ? 'newer' : 'older'}`);
        return { ok: true };
      }
    },
    generationRouter: {
      async generate(roleId, request) {
        if (snapshotCalls === 1) {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'skip',
              diagnostics: ['older-clear']
            }
          };
        }
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'compose-brief',
            diagnostics: ['newer-install']
          }
        };
      }
    }
  });
  const first = runtime.prepareForGeneration({ userMessage: 'Older clear packet.' });
  await waitUntil(() => typeof releaseFirstClear === 'function', 'first run did not enter prompt clear');
  const second = runtime.prepareForGeneration({ userMessage: 'Newer install after clear.' });
  await Promise.resolve();
  assertEqual(snapshotCalls, 1, 'newer run waits for in-flight prompt clear before snapshot');
  assertDeepEqual(sideEffects, [], 'blocked clear has not produced host side effect yet');
  releaseFirstClear();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assertEqual(firstResult.skipped, true, 'older clear run remains skipped');
  assertEqual(secondResult.ok, true, 'newer install run completes after prompt clear');
  assertDeepEqual(sideEffects, ['clear:first', 'install:newer'], 'prompt clear completes before newer install');
}

{
  let releaseFirstInstall;
  let firstInstallStarted = false;
  let snapshotCalls = 0;
  const sideEffects = [];
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => {
      snapshotCalls += 1;
      const snapshotRun = snapshotCalls <= 3 ? 1 : 2;
      return {
        chatId: `install-run-${snapshotRun}`,
        chatKey: `install-run-${snapshotRun}`,
        sceneKey: `install-scene-${snapshotRun}`,
        sceneFingerprint: `install-scene-${snapshotRun}`,
        turnFingerprint: `install-turn-${snapshotRun}`,
        latestMesId: snapshotRun,
        messages: [{ mesid: snapshotRun, role: 'user', text: snapshotRun === 1 ? 'Older install packet.' : 'Newer install packet.', visible: true }]
      };
    },
    hostPrompt: {
      async install(packet) {
        const serialized = JSON.stringify(packet);
        if (!firstInstallStarted) {
          firstInstallStarted = true;
          await new Promise((resolve) => {
            releaseFirstInstall = () => {
              sideEffects.push(serialized);
              resolve();
            };
          });
          return { ok: true };
        }
        sideEffects.push(serialized);
        return { ok: true };
      }
    }
  });
  const first = runtime.prepareForGeneration({ userMessage: 'Older install packet.' });
  await waitUntil(() => typeof releaseFirstInstall === 'function', 'first run did not enter prompt install');
  const second = runtime.prepareForGeneration({ userMessage: 'Newer install packet.' });
  await Promise.resolve();
  assertEqual(snapshotCalls, 3, 'newer run waits for in-flight prompt install before snapshot');
  assertEqual(sideEffects.length, 0, 'blocked first install has not produced host side effect yet');
  releaseFirstInstall();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assertEqual(firstResult.ok, true, 'first install completes before queued newer run starts');
  assertEqual(secondResult.ok, true, 'queued newer run completes');
  assertEqual(sideEffects.length, 2, 'both installs complete in serialized order');
  assert(sideEffects[0].includes('Older install packet.'), 'older install finishes first');
  assert(sideEffects[1].includes('Newer install packet.'), 'newer install overwrites after older install');
}

{
  let loadCalls = 0;
  let releaseFirstLoad;
  let releaseSecondLoad;
  const deferredStorage = {
    async loadSceneCache() {
      loadCalls += 1;
      if (loadCalls === 1) {
        await new Promise((resolve) => {
          releaseFirstLoad = resolve;
        });
      } else if (loadCalls === 2) {
        await new Promise((resolve) => {
          releaseSecondLoad = resolve;
        });
      }
      return null;
    },
    async saveSceneCache() {
      return {};
    },
    async appendJournal() {
      return {};
    }
  };
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'manual', reasonerUse: 'off' },
    storage: deferredStorage,
    snapshot: () => ({
      chatId: 'concurrent-chat',
      chatKey: 'concurrent-chat',
      sceneKey: 'concurrent-scene',
      sceneFingerprint: 'concurrent-scene',
      turnFingerprint: `turn-${Date.now()}`,
      latestMesId: 1,
      messages: [{ mesid: 1, role: 'user', text: 'Concurrent run.', visible: true }]
    })
  });
  const first = runtime.prepareForGeneration({ userMessage: 'first' });
  await waitUntil(() => typeof releaseFirstLoad === 'function', 'first run did not reach storage wait');
  const second = runtime.prepareForGeneration({ userMessage: 'second' });
  await waitUntil(() => typeof releaseSecondLoad === 'function', 'second run did not reach storage wait');
  const activeWithSecondBlocked = runtime.view().activeRunId;
  assert(activeWithSecondBlocked, 'overlapping run exposes active run id');
  releaseFirstLoad();
  await first;
  assertEqual(runtime.view().activeRunId, activeWithSecondBlocked, 'older run completion does not clear newer active run');
  releaseSecondLoad();
  await second;
  assertEqual(runtime.view().activeRunId, null, 'active run cleared after overlapping runs finish');
}

{
  const arbiterPrompts = [];
  const { runtime, installed, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request = {}) {
        assertEqual(roleId, 'utilityArbiter', 'manual refresh only calls utility arbiter');
        arbiterPrompts.push(request.prompt);
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            budgets: { targetBriefTokens: 500, maxCards: 4 }
          }
        };
      }
    }
  });
  const setup = await runtime.prepareForGeneration({ userMessage: 'Prepare cache before manual refresh.' });
  assertEqual(setup.ok, true, 'manual refresh setup prepares generation');
  const setupSnapshot = runtime.view().lastSnapshot;
  const result = await runtime.refreshScene();
  assertEqual(result.ok, true, 'manual refresh prepares generation');
  assertEqual(installed.length, 2, 'manual refresh installs prompt after cache invalidation');
  assert(arbiterPrompts[1].includes('"cacheState":"stale"'), 'manual refresh Arbiter prompt sees stale prior cache');
  assert(arbiterPrompts[1].includes('"reason":"user-refresh"'), 'manual refresh Arbiter prompt sees invalidation reason');
  const refreshedSnapshot = parsePromptJsonSection(arbiterPrompts[1], 'Snapshot');
  assert(!refreshedSnapshot.messages.some((message) => message.text === 'manual refresh'), 'manual refresh does not inject synthetic chat text');
  const journal = await storage.loadRunJournal(setupSnapshot.chatKey);
  assert(journal.entries.some((entry) => entry.event === 'cache.invalidated' && entry.details?.reason === 'user-refresh'), 'manual refresh records cache invalidation journal');
  assertEqual(runtime.view().activeRunId, null, 'active run cleared after refresh');
}

{
  const { runtime, calls, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' }
  });
  const setup = await runtime.prepareForGeneration({ userMessage: 'Prepare cache before scene reset.' });
  assertEqual(setup.ok, true, 'scene reset setup prepares generation');
  const setupView = runtime.view();
  assert(setupView.lastPacket, 'scene reset setup has prompt packet before reset');
  assert(setupView.lastHand.cards.length > 0, 'scene reset setup has hand cards before reset');
  const setupSnapshot = setupView.lastSnapshot;
  assert(await storage.loadSceneCache(setupSnapshot.chatKey, setupSnapshot.sceneKey), 'scene cache exists before reset');
  const result = await runtime.resetSceneCache();
  assertEqual(result.ok, true, 'scene cache reset succeeds');
  assertEqual(result.chatKey, setupSnapshot.chatKey, 'scene cache reset targets current chat');
  assertEqual(result.sceneKey, setupSnapshot.sceneKey, 'scene cache reset targets current scene');
  assertEqual(result.clear.ok, true, 'scene cache reset clears host prompt');
  assertEqual(calls.clear, 1, 'scene cache reset calls host prompt clear');
  assertEqual(await storage.loadSceneCache(setupSnapshot.chatKey, setupSnapshot.sceneKey), null, 'scene cache reset deletes current cache');
  const resetView = runtime.view();
  assertEqual(resetView.lastPacket, null, 'scene cache reset clears in-memory prompt packet');
  assertEqual(resetView.lastHand.cards.length, 0, 'scene cache reset clears in-memory hand');
  assertEqual(resetView.lastPlan, null, 'scene cache reset clears in-memory plan');
  assertEqual(resetView.activity.label, 'Scene cache reset. Prompt cleared.', 'scene cache reset surfaces success activity');
  assertEqual(resetView.activity.severity, 'success', 'scene cache reset success is visible');
}

{
  const adapter = createMemoryStorageAdapter();
  const repository = createStorageRepository({ storage: adapter });
  let releaseRefreshInvalidation;
  let refreshInvalidationStarted = false;
  let snapshotReads = 0;
  const storage = {
    async loadSceneCache(...args) {
      return repository.loadSceneCache(...args);
    },
    async saveSceneCache(...args) {
      return repository.saveSceneCache(...args);
    },
    async appendJournal(...args) {
      return repository.appendJournal(...args);
    },
    async loadRunJournal(...args) {
      return repository.loadRunJournal(...args);
    },
    async invalidateSceneCache(...args) {
      refreshInvalidationStarted = true;
      await new Promise((resolve) => {
        releaseRefreshInvalidation = resolve;
      });
      return repository.invalidateSceneCache(...args);
    }
  };
  let currentTurn = {
    chatId: 'refresh-race-chat',
    chatKey: 'refresh-race-chat',
    sceneKey: 'refresh-race-scene',
    sceneFingerprint: 'refresh-race-scene',
    turnFingerprint: 'refresh-race-turn-initial',
    latestMesId: 1,
    messages: [{ mesid: 1, role: 'user', text: 'Refresh race initial.', visible: true }]
  };
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    snapshot: () => {
      snapshotReads += 1;
      return currentTurn;
    }
  });
  const setup = await runtime.prepareForGeneration({ userMessage: 'Create cache before refresh race.' });
  assertEqual(setup.ok, true, 'refresh race setup installs');
  const refresh = runtime.refreshScene();
  await waitUntil(() => refreshInvalidationStarted, 'refresh invalidation did not start');
  const snapshotReadsBeforeFollowup = snapshotReads;
  currentTurn = {
    chatId: 'refresh-race-chat',
    chatKey: 'refresh-race-chat',
    sceneKey: 'refresh-race-scene',
    sceneFingerprint: 'refresh-race-scene',
    turnFingerprint: 'refresh-race-turn-followup',
    latestMesId: 10,
    messages: [{ mesid: 10, role: 'user', text: 'Refresh race followup base.', visible: true }]
  };
  const followup = runtime.prepareForGeneration({ userMessage: 'Newer turn after refresh.' });
  await Promise.resolve();
  assertEqual(snapshotReads, snapshotReadsBeforeFollowup, 'newer run waits for refresh invalidation storage tail before snapshot');
  releaseRefreshInvalidation();
  const [refreshResult, followupResult] = await Promise.all([refresh, followup]);
  assert(refreshResult.ok || refreshResult.superseded, 'refresh race run resolves');
  assertEqual(followupResult.ok, true, 'newer run completes after refresh invalidation');
  assertEqual(followupResult.skipped, undefined, 'newer run does not skip after refresh invalidation');
  const finalSnapshot = runtime.view().lastSnapshot;
  const cache = await repository.loadSceneCache(finalSnapshot.chatKey, finalSnapshot.sceneKey);
  assertEqual(cache.cacheState, 'active', 'newer run active cache survives delayed refresh invalidation');
}

{
  const routerCalls = [];
  const { runtime, settingsStore } = createRuntimeHarness({
    generationRouter: {
      async generate(roleId, request, options) {
        routerCalls.push({ roleId, request, options });
        return {
          ok: true,
          diagnostics: { providerId: 'host-current-model', model: 'utility-test-model' },
          data: { schema: 'recursion.providerTest.v1', ok: true }
        };
      }
    }
  });

  const updated = await runtime.updateSettings({
    mode: 'auto',
    strength: 'strong',
    promptFootprint: 'rich',
    focus: 'character',
    reasonerUse: 'always',
    storyFormOverride: 'present-mixed'
  });
  assertEqual(updated.ok, true, 'runtime exposes successful high-level settings update');
  assertEqual(updated.settings.mode, 'auto', 'runtime exposes high-level settings update');
  assertEqual(updated.settings.strength, 'strong', 'runtime settings update preserves strength');
  assertEqual(runtime.view().settings.focus, 'character', 'settings update is visible in runtime view');
  assertEqual(runtime.view().settings.storyFormOverride, 'present-mixed', 'settings update exposes mixed story form override in runtime view');

  const utilityResult = await runtime.updateProvider('utility', {
    source: 'openai-compatible',
    apiKey: 'sk-runtime-secret',
    openAICompatible: { baseUrl: 'https://example.test/v1', model: 'utility-model' },
    temperature: 0.2,
    topP: 0.8,
    maxTokens: 2048
  });
  assertEqual(utilityResult.ok, true, 'runtime provider update returns success result');
  assertEqual(utilityResult.clear.ok, true, 'runtime provider update returns prompt clear result');
  const utility = utilityResult.provider;
  assertEqual(utility.openAICompatible.sessionApiKeyPresent, true, 'runtime provider update accepts session key');
  assertEqual(settingsStore.getApiKey('utility'), 'sk-runtime-secret', 'runtime provider update stores key in session store');
  assert(!JSON.stringify(settingsStore.get()).includes('sk-runtime-secret'), 'runtime provider update does not persist api key');
  const viewProvider = runtime.view().settings.providers.utility;
  assertEqual(viewProvider.openAICompatible.baseUrl, 'https://example.test/v1', 'runtime view exposes safe provider base URL for UI round-trip');
  assertEqual(viewProvider.openAICompatible.model, 'utility-model', 'runtime view exposes safe provider model for UI round-trip');
  assertEqual(viewProvider.openAICompatible.sessionApiKeyPresent, true, 'runtime view exposes safe session key presence flag');
  assertEqual(viewProvider.temperature, 0.2, 'runtime view exposes provider temperature for UI round-trip');
  assertEqual(viewProvider.topP, 0.8, 'runtime view exposes provider topP for UI round-trip');
  assertEqual(viewProvider.maxTokens, 2048, 'runtime view exposes provider maxTokens for UI round-trip');
  assertNoSecretText(runtime.view().settings, 'runtime provider settings view');

  const providerTest = await runtime.testProvider('utility');
  assertEqual(providerTest.ok, true, 'runtime provider test returns success result');
  assertEqual(routerCalls[0].roleId, 'providerTest', 'runtime provider test uses providerTest role');
  assertEqual(routerCalls[0].request.lane, 'utility', 'runtime provider test targets selected lane');
  assertEqual(routerCalls[0].request.reasoningCategory, 'provider-test', 'runtime provider test labels diagnostic provider calls');
  assertEqual(routerCalls[0].request.reasoningIntent, 'minimal', 'runtime provider test always uses minimal provider reasoning');
  assertEqual(routerCalls[0].request.responseLength, 2048, 'runtime provider test uses the configured lane max tokens');
  assertEqual(routerCalls[0].options.timeoutMs, 30000, 'runtime provider test uses a bounded test timeout');
  assertEqual(settingsStore.get().providers.utility.lastTest.status, 'pass', 'runtime provider test records passing provider status');
  assertEqual(settingsStore.get().providers.utility.resolvedModelLabel, 'utility-test-model', 'runtime provider test records resolved model');

  const cleared = await runtime.clearProviderKey('utility');
  assertEqual(cleared.ok, true, 'runtime provider key clear returns success result');
  assertEqual(cleared.clear.ok, true, 'runtime provider key clear returns prompt clear result');
  assertEqual(cleared.provider.openAICompatible.sessionApiKeyPresent, false, 'runtime can clear provider session key');
  assertEqual(settingsStore.getApiKey('utility'), '', 'runtime provider key clear removes session secret');
}

{
  const { runtime } = createRuntimeHarness({
    settings: {
      mode: 'auto',
      reasonerUse: 'off',
      storyFormOverride: 'present-mixed'
    },
    snapshot: {
      chatId: 'story-form-override-chat',
      chatKey: 'story-form-override-chat',
      sceneKey: 'story-form-override-scene',
      sceneFingerprint: 'story-form-override-scene-fp',
      sourceRevisionHash: 'story-form-override-source',
      turnFingerprint: 'story-form-override-turn',
      latestMesId: 2,
      messages: [
        { mesid: 1, role: 'assistant', text: 'I walk to the door. I touch the knob. I feel it turn.', visible: true },
        { mesid: 2, role: 'user', text: 'Keep going.', visible: true }
      ]
    },
    generationRouter: {
      async generate(roleId, request = {}) {
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              sceneStatus: 'same-scene',
              promptFootprint: 'normal',
              cardJobs: [],
              storyForm: {
                schema: 'recursion.storyForm.v1',
                tense: 'present',
                pov: 'first-person',
                confidence: 'high',
                evidenceRefs: ['message:1'],
                reason: 'Provider followed the visible first-person text.'
              },
              reasonerDecision: { mode: 'skip', reason: 'override regression', signals: [] },
              budgets: { targetBriefTokens: 500, maxCards: 0 },
              diagnostics: ['story-form-override-regression']
            }
          };
        }
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'Respect the selected story form.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['story-form-override-guidance']
            }
          };
        }
        throw new Error(`unexpected story-form override role ${roleId}`);
      }
    }
  });

  const result = await runtime.prepareForGeneration({ userMessage: 'Keep going.' });
  assertEqual(result.ok, true, 'story form override run installs');
  assertEqual(result.packet.storyForm.tense, 'present', 'story form override controls packet tense');
  assertEqual(result.packet.storyForm.pov, 'mixed', 'story form override controls packet pov');
  assertEqual(result.packet.diagnostics.storyFormPov, 'mixed', 'packet diagnostics expose mixed POV');
  assert(result.packet.sections.guidance.includes('present tense, mixed POV'), 'story form override reaches guidance section');
  assertNotEqual(
    rapidWarmContractVersions({ storyFormOverride: 'auto' }).settingsHash,
    rapidWarmContractVersions({ storyFormOverride: 'present-mixed' }).settingsHash,
    'Rapid warm signature changes for present mixed override'
  );
}

{
  const { runtime, settingsStore } = createRuntimeHarness({
    settings: { reasonerUse: 'always', providers: { reasoner: { enabled: true } } },
    generationRouter: {
      async generate(roleId, request) {
        return {
          ok: false,
          error: {
            code: 'RECURSION_PROVIDER_KEY_MISSING',
            message: 'Bearer sk-runtime-secret should not leak'
          }
        };
      }
    }
  });

  const failed = await runtime.testProvider('reasoner');
  assertEqual(failed.ok, false, 'runtime provider test returns failure result');
  const reasoner = settingsStore.get().providers.reasoner;
  assertEqual(reasoner.lastTest.status, 'fail', 'runtime provider test records failing provider status');
  assertNoSecretText(reasoner.lastTest, 'provider test failure status');
}

{
  const { runtime, settingsStore } = createRuntimeHarness({
    settings: {
      providers: {
        utility: {
          resolvedProviderLabel: 'stale-provider',
          resolvedModelLabel: 'stale-model'
        }
      }
    },
    generationRouter: {
      async generate(roleId, request) {
        return {
          ok: true,
          diagnostics: { providerId: 'unsafe-provider', model: 'unsafe-model' },
          data: {
            schema: 'wrong.providerTest.schema',
            ok: true,
            detail: 'Bearer invalid-provider-token and sk-invalid-provider'
          }
        };
      }
    }
  });

  const invalid = await runtime.testProvider('utility');
  assertEqual(invalid.ok, false, 'runtime provider test rejects invalid success schema');
  assertEqual(invalid.error.code, 'RECURSION_PROVIDER_TEST_INVALID', 'invalid provider test returns stable error code');
  const utility = settingsStore.get().providers.utility;
  assertEqual(utility.lastTest.status, 'fail', 'invalid provider test records failing status');
  assertEqual(utility.resolvedProviderLabel, '', 'invalid provider test clears stale provider label');
  assertEqual(utility.resolvedModelLabel, '', 'invalid provider test does not record resolved model');
  assertNoSecretText(utility.lastTest, 'invalid provider test status');
  assertNoSecretText(invalid, 'invalid provider test result');
}

{
  const { runtime, settingsStore } = createRuntimeHarness({
    settings: {
      providers: {
        utility: {
          resolvedProviderLabel: 'stale-provider',
          resolvedModelLabel: 'stale-model'
        }
      }
    },
    generationRouter: {
      async generate(roleId, request) {
        return {
          ok: true,
          diagnostics: { providerId: 'unsafe-provider', model: 'unsafe-model' },
          data: {
            schema: 'recursion.providerTest.v1',
            ok: false,
            message: 'Bearer false-provider-token and sk-false-provider'
          }
        };
      }
    }
  });

  const invalid = await runtime.testProvider('utility');
  assertEqual(invalid.ok, false, 'runtime provider test rejects schema success with false ok flag');
  assertEqual(invalid.error.code, 'RECURSION_PROVIDER_TEST_INVALID', 'false-ok provider test returns stable error code');
  const utility = settingsStore.get().providers.utility;
  assertEqual(utility.lastTest.status, 'fail', 'false-ok provider test records failing status');
  assertEqual(utility.resolvedProviderLabel, '', 'false-ok provider test clears stale provider label');
  assertEqual(utility.resolvedModelLabel, '', 'false-ok provider test clears stale model label');
  assertNoSecretText(utility.lastTest, 'false-ok provider test status');
  assertNoSecretText(invalid, 'false-ok provider test result');
}

{
  const { runtime, settingsStore } = createRuntimeHarness({
    settings: {
      providers: {
        utility: {
          resolvedProviderLabel: 'stale-provider',
          resolvedModelLabel: 'stale-model'
        }
      }
    },
    generationRouter: {
      async generate(roleId, request) {
        return {
          ok: true,
          diagnostics: { providerId: 'unsafe-provider', model: 'unsafe-model' },
          data: {
            schema: 'recursion.providerTest.v1',
            message: 'Bearer missing-ok-provider-token and sk-missing-ok-provider'
          }
        };
      }
    }
  });

  const invalid = await runtime.testProvider('utility');
  assertEqual(invalid.ok, false, 'runtime provider test rejects schema success with missing ok flag');
  assertEqual(invalid.error.code, 'RECURSION_PROVIDER_TEST_INVALID', 'missing-ok provider test returns stable error code');
  const utility = settingsStore.get().providers.utility;
  assertEqual(utility.lastTest.status, 'fail', 'missing-ok provider test records failing status');
  assertEqual(utility.resolvedProviderLabel, '', 'missing-ok provider test clears stale provider label');
  assertEqual(utility.resolvedModelLabel, '', 'missing-ok provider test clears stale model label');
  assertNoSecretText(utility.lastTest, 'missing-ok provider test status');
  assertNoSecretText(invalid, 'missing-ok provider test result');
}

{
  const repository = createStorageRepository({ storage: createMemoryStorageAdapter() });
  const maintenanceCalls = [];
  const storage = {
    async loadSceneCache(...args) {
      return repository.loadSceneCache(...args);
    },
    async saveSceneCache(...args) {
      return repository.saveSceneCache(...args);
    },
    async appendJournal(...args) {
      return repository.appendJournal(...args);
    },
    async loadRunJournal(...args) {
      return repository.loadRunJournal(...args);
    },
    async maintainRetention(options = {}) {
      maintenanceCalls.push(options);
      return { ok: true };
    }
  };
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasoningLevel: 'low' },
    storage,
    generationRouter: localFallbackCardRouter(['runtime-maintenance-test'])
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Trigger retention maintenance.' });
  const snapshot = runtime.view().lastSnapshot;
  assertEqual(result.ok, true, 'runtime maintenance test installs');
  assert(maintenanceCalls.length > 0, 'runtime calls retention maintenance after scene-cache save');
  assertDeepEqual(
    maintenanceCalls.at(-1).activeScene,
    { chatKey: snapshot.chatKey, sceneKey: snapshot.sceneKey },
    'runtime maintenance protects active scene'
  );
}

console.log('[pass] runtime');
