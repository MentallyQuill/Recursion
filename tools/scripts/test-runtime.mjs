import {
  activeDeckRevisionHash,
  cacheContractVersions,
  createRecursionRuntime,
  filterCardsForCardEligibility,
  filterPlanForCardEligibility,
  generationBasisForLatestAssistantSwipe,
  generationBasisForSnapshot,
  preparedGenerationContract,
  preparedGenerationSettingsSignature
} from '../../src/runtime.mjs';
import { createActivityReporter } from '../../src/activity.mjs';
import { createSettingsStore } from '../../src/settings.mjs';
import { createMemoryStorageAdapter, createStorageRepository } from '../../src/storage.mjs';
import { createGenerationRouter, createProviderClient } from '../../src/providers.mjs';
import { createSillyTavernHost } from '../../src/hosts/sillytavern/host.mjs';
import { createRuntimeRunState } from '../../src/runtime/run-state.mjs';
import { clearPromptBestEffort, installPrompt } from '../../src/runtime/prompt-install.mjs';
import { runFusedCardPipeline } from '../../src/runtime/pipelines/fused.mjs';
import { runSegmentedCardPipeline } from '../../src/runtime/pipelines/segmented.mjs';
import { CARD_CATALOG, cardsFromProviderResult } from '../../src/cards.mjs';
import {
  CARD_SCOPE_CATALOG,
  defaultCardScope,
  manualSelectedFamilies,
  normalizeCardScope,
  setFamilyEnabled,
  setSubItemEnabled
} from '../../src/card-scope.mjs';
import { activeCardDeckRuntimeScope, createDefaultCardDeck } from '../../src/pre-process-decks.mjs';
import { packetToPromptBlocks } from '../../src/prompt.mjs';
import { createHeroPixelBlocks, createProgressRunModel } from '../../src/progress.mjs';
import { hashJson } from '../../src/core.mjs';
import { providerConfigHash } from '../../src/provider-capability.mjs';
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

async function waitUntil(predicate, message, { attempts = 100, delayMs = 1 } = {}) {
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

const preparedGenerationSettings = {
  enabled: true,
  mode: 'auto',
  pipelineMode: 'fused',
  strength: 'strong',
  minCards: 2,
  maxCards: 7,
  reasoningLevel: 'high',
  promptFootprint: 'rich',
  focus: 'scene',
  reasonerUse: 'always',
  storyFormOverride: 'screenplay',
  injection: { placement: 'in_chat', role: 'user', depth: 3 },
  retention: {
    sourceWindowMessages: 24,
    sourceWindowCharacters: 12000,
    providerVisibleMessages: 18
  },
  providers: {
    utility: {
      lane: 'utility',
      connectionProfileId: 'utility-profile',
      generationPolicy: {
        presetMode: 'isolated',
        instructMode: 'auto',
        samplerMode: 'profile',
        structuredOutputMode: 'auto'
      },
      samplerOverrides: { temperature: 0.2, topP: 0.8 },
      outputTokenCeiling: 4096,
      configRevision: 2,
      certification: { status: 'partial' }
    },
    reasoner: {
      lane: 'reasoner',
      connectionProfileId: 'reasoner-profile',
      generationPolicy: {
        presetMode: 'full-profile',
        instructMode: 'off',
        samplerMode: 'recursion',
        structuredOutputMode: 'prompt-json'
      },
      samplerOverrides: { temperature: 0.4, topP: 0.9 },
      outputTokenCeiling: 8192,
      configRevision: 4,
      certification: { status: 'fail' }
    }
  },
  postProcess: { enabled: true, applyMode: 'replace', rewriteFlow: 'progressive', contextMessages: 21 },
  diagnostics: { includeExcerpts: true },
  ui: { viewerOpen: true, tooltipsEnabled: false }
};

const preparedGenerationSnapshot = {
  chatId: 'task-2a-chat',
  chatKey: 'task-2a-chat',
  sceneKey: 'task-2a-scene',
  sceneFingerprint: 'task-2a-scene-fingerprint',
  latestMesId: 9,
  sourceRevisionHash: 'task-2a-source-revision',
  messages: [
    {
      mesid: 7,
      role: 'assistant',
      text: 'Older assistant text must not be stored in the basis.',
      swipeId: 2,
      swipeCount: 3,
      activeSwipeTextHash: 'older-assistant-active-swipe',
      visible: true
    },
    { mesid: 8, role: 'user', text: 'The current player request.', visible: true },
    { mesid: 9, role: 'system', text: 'Current scene state.', visible: true }
  ]
};

{
  const basis = generationBasisForSnapshot(preparedGenerationSnapshot, preparedGenerationSettings);
  assertDeepEqual(basis, {
    chatKey: 'task-2a-chat',
    sceneKey: 'task-2a-scene',
    sceneFingerprint: 'task-2a-scene-fingerprint',
    latestMesId: 9,
    sourceRevisionHash: 'task-2a-source-revision',
    sourceWindow: [
      {
        mesid: 7,
        role: 'assistant',
        textHash: hashJson('Older assistant text must not be stored in the basis.'),
        swipeId: 2,
        swipeCount: 3,
        activeSwipeTextHash: 'older-assistant-active-swipe'
      },
      { mesid: 8, role: 'user', textHash: hashJson('The current player request.') },
      { mesid: 9, role: 'system', textHash: hashJson('Current scene state.') }
    ],
    sourceWindowTruncated: false,
    sourceWindowLimitReason: '',
    sourceWindowContractHash: hashJson({ sourceWindowMessages: 24, sourceWindowCharacters: 12000 })
  }, 'generation basis normalizes a compact text-free source identity');
  assertEqual(JSON.stringify(basis).includes('current player request'), false, 'generation basis does not retain source text');
  assertEqual(generationBasisForSnapshot({ messages: [] }, preparedGenerationSettings), null, 'empty normal basis rejects reuse');
}

{
  const swipeSnapshot = {
    ...preparedGenerationSnapshot,
    sourceRevisionHash: '',
    latestMesId: 10,
    messages: [
      ...preparedGenerationSnapshot.messages,
      { mesid: 10, role: 'assistant', text: 'This is the output being replaced.', swipeId: 1, swipeCount: 2, visible: true }
    ]
  };
  const sourceBeforeAssistant = { ...preparedGenerationSnapshot, sourceRevisionHash: '' };
  const basis = generationBasisForLatestAssistantSwipe(swipeSnapshot, 10, preparedGenerationSettings);
  assertDeepEqual(basis, generationBasisForSnapshot(sourceBeforeAssistant, preparedGenerationSettings), 'swipe basis removes only the latest visible assistant');
  const emptyPlaceholderSnapshot = {
    ...swipeSnapshot,
    messages: [
      ...preparedGenerationSnapshot.messages,
      { mesid: 10, role: 'assistant', text: '', swipeId: 1, swipeCount: 2, visible: true }
    ]
  };
  assertDeepEqual(
    generationBasisForLatestAssistantSwipe(emptyPlaceholderSnapshot, 10, preparedGenerationSettings),
    generationBasisForSnapshot(sourceBeforeAssistant, preparedGenerationSettings),
    'swipe basis removes SillyTavern empty assistant generation placeholders'
  );
  assertEqual(generationBasisForLatestAssistantSwipe(swipeSnapshot, 999, preparedGenerationSettings), null, 'wrong swipe message id rejects reuse');
  assertEqual(generationBasisForLatestAssistantSwipe(preparedGenerationSnapshot, 9, preparedGenerationSettings), null, 'missing latest assistant rejects reuse');
  assertEqual(generationBasisForLatestAssistantSwipe({
    latestMesId: 10,
    messages: [{ mesid: 10, role: 'assistant', text: 'Only assistant output.', visible: true }]
  }, 10, preparedGenerationSettings), null, 'assistant-only swipe basis rejects reuse');
}

{
  const baseline = generationBasisForSnapshot(preparedGenerationSnapshot, preparedGenerationSettings);
  const messageBoundSettings = clone(preparedGenerationSettings);
  messageBoundSettings.retention.sourceWindowMessages = 23;
  const characterBoundSettings = clone(preparedGenerationSettings);
  characterBoundSettings.retention.sourceWindowCharacters = 11000;
  assertNotEqual(
    generationBasisForSnapshot(preparedGenerationSnapshot, messageBoundSettings).sourceWindowContractHash,
    baseline.sourceWindowContractHash,
    'message source-window cap changes the basis contract hash'
  );
  assertNotEqual(
    generationBasisForSnapshot(preparedGenerationSnapshot, characterBoundSettings).sourceWindowContractHash,
    baseline.sourceWindowContractHash,
    'character source-window cap changes the basis contract hash'
  );
}

{
  const hostBoundedSwipeSnapshot = {
    chatId: 'host-shaped-chat',
    sceneKey: 'host-shaped-scene',
    sceneFingerprint: 'host-shaped-fingerprint',
    latestMesId: 32,
    messages: [
      { mesid: 30, is_user: false, name: 'Mara', mes: 'Earlier assistant source.', swipe_id: 1, swipes: ['Earlier assistant source.', 'Alternate earlier assistant source.'] },
      { mesid: 31, is_user: true, name: 'Player', mes: 'Host-bounded user request.' },
      { mesid: 32, is_user: false, name: 'Mara', mes: 'Assistant output being swiped.', swipe_id: 0, swipes: ['Assistant output being swiped.'] }
    ]
  };
  const basis = generationBasisForLatestAssistantSwipe(hostBoundedSwipeSnapshot, 32, preparedGenerationSettings);
  assertDeepEqual(basis.sourceWindow.map((message) => ({ mesid: message.mesid, role: message.role })), [
    { mesid: 30, role: 'assistant' },
    { mesid: 31, role: 'user' }
  ], 'host-shaped bounded swipe fixture removes its latest assistant without requiring system messages');
  assertEqual(basis.sourceWindow.some((message) => message.role === 'system'), false, 'host-shaped bounded fixture has no synthetic system source');
}

{
  const original = preparedGenerationContract(preparedGenerationSettings);
  const mutations = [
    ['enabled', (settings) => { settings.enabled = false; }],
    ['mode', (settings) => { settings.mode = 'manual'; }],
    ['pipelineMode', (settings) => { settings.pipelineMode = 'segmented'; }],
    ['strength', (settings) => { settings.strength = 'light'; }],
    ['minCards', (settings) => { settings.minCards = 1; }],
    ['maxCards', (settings) => { settings.maxCards = 8; }],
    ['reasoningLevel', (settings) => { settings.reasoningLevel = 'ultra'; }],
    ['promptFootprint', (settings) => { settings.promptFootprint = 'compact'; }],
    ['focus', (settings) => { settings.focus = 'plot'; }],
    ['storyFormOverride', (settings) => { settings.storyFormOverride = 'present-first-person'; }],
    ['injection.placement', (settings) => { settings.injection.placement = 'in_prompt'; }],
    ['injection.role', (settings) => { settings.injection.role = 'system'; }],
    ['injection.depth', (settings) => { settings.injection.depth = 4; }],
    ['retention.sourceWindowMessages', (settings) => { settings.retention.sourceWindowMessages = 23; }],
    ['retention.sourceWindowCharacters', (settings) => { settings.retention.sourceWindowCharacters = 11000; }],
    ['retention.providerVisibleMessages', (settings) => { settings.retention.providerVisibleMessages = 17; }],
    ...['utility', 'reasoner'].flatMap((lane) => [
      [`providers.${lane}.connectionProfileId`, (settings) => { settings.providers[lane].connectionProfileId = `${lane}-profile-next`; }],
      [`providers.${lane}.generationPolicy.presetMode`, (settings) => { settings.providers[lane].generationPolicy.presetMode = settings.providers[lane].generationPolicy.presetMode === 'isolated' ? 'full-profile' : 'isolated'; }],
      [`providers.${lane}.generationPolicy.instructMode`, (settings) => { settings.providers[lane].generationPolicy.instructMode = 'on'; }],
      [`providers.${lane}.generationPolicy.samplerMode`, (settings) => { settings.providers[lane].generationPolicy.samplerMode = settings.providers[lane].generationPolicy.samplerMode === 'profile' ? 'recursion' : 'profile'; }],
      [`providers.${lane}.generationPolicy.structuredOutputMode`, (settings) => { settings.providers[lane].generationPolicy.structuredOutputMode = 'native-schema'; }],
      [`providers.${lane}.samplerOverrides.temperature`, (settings) => { settings.providers[lane].samplerOverrides.temperature += 0.1; }],
      [`providers.${lane}.samplerOverrides.topP`, (settings) => { settings.providers[lane].samplerOverrides.topP -= 0.1; }],
      [`providers.${lane}.outputTokenCeiling`, (settings) => { settings.providers[lane].outputTokenCeiling -= 1; }],
      [`providers.${lane}.configRevision`, (settings) => { settings.providers[lane].configRevision += 1; }]
    ])
  ];
  for (const [label, mutate] of mutations) {
    const changed = clone(preparedGenerationSettings);
    mutate(changed);
    assertNotEqual(preparedGenerationContract(changed).packetInputHash, original.packetInputHash, `${label} changes the packet-input hash`);
  }
  const rawReasonerUseOverride = clone(preparedGenerationSettings);
  rawReasonerUseOverride.reasonerUse = 'off';
  assertEqual(
    preparedGenerationContract(rawReasonerUseOverride).packetInputHash,
    original.packetInputHash,
    'equivalent raw reasonerUse does not change the packet-input hash when reasoning level is unchanged'
  );
}

{
  const deckSettings = clone(preparedGenerationSettings);
  deckSettings.preProcessDecks = {
    activeDeckId: 'task-2a-deck',
    customDecks: {
      'task-2a-deck': {
        id: 'task-2a-deck',
        name: 'Task 2A Deck',
        categoryOrder: ['scene-frame'],
        categories: { 'scene-frame': { id: 'scene-frame', name: 'Scene Frame' } },
        cardOrderByCategory: { 'scene-frame': ['active-card'] },
        cards: {
          'active-card': {
            id: 'active-card',
            categoryId: 'scene-frame',
            name: 'Active Card',
            promptText: 'Original active card prompt.',
            selectionState: 'active',
            builtinFamily: 'Scene Frame'
          }
        }
      }
    }
  };
  const cardId = 'active-card';
  const before = activeDeckRevisionHash(deckSettings);
  const beforePacketInputHash = preparedGenerationContract(deckSettings).packetInputHash;
  deckSettings.preProcessDecks.customDecks['task-2a-deck'].cards[cardId].promptText = 'Updated active card prompt.';
  assertNotEqual(activeDeckRevisionHash(deckSettings), before, 'active card prompt text changes the deck revision hash');
  assertNotEqual(preparedGenerationContract(deckSettings).packetInputHash, beforePacketInputHash, 'active card prompt text changes the packet-input hash');
}

{
  const baseline = preparedGenerationContract(preparedGenerationSettings).packetInputHash;
  const neutralMutations = [
    ['post-process enabled', (settings) => { settings.postProcess.enabled = false; }],
    ['post-process apply mode', (settings) => { settings.postProcess.applyMode = 'as-swipe'; }],
    ['post-process rewrite flow', (settings) => { settings.postProcess.rewriteFlow = 'unified'; }],
    ['post-process context', (settings) => { settings.postProcess.contextMessages = 7; }],
    ['diagnostics', (settings) => { settings.diagnostics.includeExcerpts = false; }],
    ['ui', (settings) => { settings.ui.viewerOpen = false; }],
    ['utility certification', (settings) => { settings.providers.utility.certification.status = 'fail'; }],
    ['reasoner certification', (settings) => { settings.providers.reasoner.certification.status = 'pass'; }]
  ];
  for (const [label, mutate] of neutralMutations) {
    const changed = clone(preparedGenerationSettings);
    mutate(changed);
    assertEqual(preparedGenerationContract(changed).packetInputHash, baseline, `${label} does not change the packet-input hash`);
  }
  const signature = preparedGenerationSettingsSignature(preparedGenerationSettings);
  assertEqual(signature.reasonerUse, 'always', 'settings signature includes normalized reasoner use');
  assertEqual(Object.hasOwn(signature, 'postProcess'), false, 'pre-process settings signature omits post-process settings');
  assertEqual(Object.hasOwn(signature, 'diagnostics'), false, 'settings signature omits diagnostics settings');
  assertEqual(Object.hasOwn(signature, 'ui'), false, 'settings signature omits UI settings');
}

{
  const runState = createRuntimeRunState();
  runState.setActiveRun('run-state-1', { abort() {} });
  assertEqual(runState.current().activeRunId, 'run-state-1', 'run state stores active run id');
  runState.setLatestAssistantSwipeRetry({ reason: 'latest-assistant-swipe' });
  assertEqual(runState.takeLatestAssistantSwipeRetry().reason, 'latest-assistant-swipe', 'run state takes swipe retry once');
  assertEqual(runState.takeLatestAssistantSwipeRetry(), null, 'swipe retry is cleared after take');
  runState.setQueuedFullFresh({ id: 'fresh-1' });
  assertEqual(runState.takeQueuedFullFresh().id, 'fresh-1', 'queued full-fresh token is taken once');
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
  const segmentedResult = await runSegmentedCardPipeline({
    plan: pipelinePlan,
    snapshot: {},
    settings: { pipelineMode: 'segmented' },
    requests: [pipelineRequest],
    sourceContext: pipelineSourceContext,
    generationRouter: {
      async generate(roleId) {
        pipelineCalls.push(`segmented:${roleId}`);
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
  assertEqual(segmentedResult.cards.length, 1, 'Segmented pipeline returns parsed card result');

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
  assertDeepEqual(pipelineCalls, ['segmented:sceneFrameCard', 'fused:fusedCardBundle'], 'Segmented and Fused helpers call their matching provider roles');
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

function providerCertificationSettings(settings = {}, lane = 'reasoner', status = 'pass') {
  const store = createSettingsStore({ root: {} });
  store.update(settings);
  let provider = store.get().providers[lane];
  if (!provider.connectionProfileId) {
    store.updateProviderConfig(lane, { connectionProfileId: `${lane}-profile` });
    provider = store.get().providers[lane];
  }
  const passed = status === 'pass';
  const certification = store.recordProviderCertification(lane, {
    status: passed ? 'pass' : 'fail',
    checkedAt: '2026-07-17T00:00:00.000Z',
    completionMode: 'chat',
    structuredOutput: 'prompt-json',
    checks: passed
      ? { connectivity: 'pass', singleCard: 'pass', fusedCards: 'pass' }
      : { connectivity: 'pass', singleCard: 'fail', fusedCards: 'not-run' },
    safeConcurrency: 1,
    diagnosticCodes: passed ? [] : ['unit-certification-failed'],
    ...(passed ? {} : { compactError: 'RECURSION_PROVIDER_FAILED: Profile certification failed.' })
  }, {
    configHash: providerConfigHash(provider),
    configRevision: provider.configRevision
  });
  assertEqual(certification.ok, true, `${lane} fixture records hash-bound ${status} certification`);
  return store.get();
}

function fusedReadyReasonerSettings(settings = {}) {
  return providerCertificationSettings(settings, 'reasoner', 'pass');
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

function profileCertificationResponse(roleId) {
  if (roleId === 'providerTest') {
    return { ok: true, data: { schema: 'recursion.providerTest.v1', ok: true } };
  }
  if (roleId === 'sceneFrameCard') {
    return {
      ok: true,
      data: {
        promptText: 'Track the immediate objective and obstruction.',
        evidenceRefs: ['message:0']
      }
    };
  }
  if (roleId === 'fusedCardBundle') {
    return {
      ok: true,
      data: {
        items: [
          {
            family: 'Scene Frame',
            promptText: 'Track the immediate objective and obstruction.',
            evidenceRefs: ['message:0']
          },
          {
            family: 'Scene Constraints',
            promptText: 'Preserve the immediate boundary.',
            evidenceRefs: ['message:0']
          }
        ]
      }
    };
  }
  throw new Error(`unexpected profile certification role ${roleId}`);
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

function preProcessDecksForScope(scope) {
  const normalizedScope = normalizeCardScope(scope);
  const deck = createDefaultCardDeck();
  deck.id = 'runtime-scope-deck';
  deck.name = 'Runtime Scope Deck';
  deck.bundled = false;
  deck.readonly = false;
  for (const card of Object.values(deck.cards)) {
    const familyScope = normalizedScope.families[card.builtinFamily];
    const selectedSubItems = Array.isArray(card.selectedSubItems) ? card.selectedSubItems : [];
    const selected = familyScope?.enabled === true
      && selectedSubItems.some((key) => familyScope.subItems?.[key] === true);
    card.selectionState = selected ? 'active' : 'off';
  }
  return {
    version: 1,
    activeDeckId: deck.id,
    customDecks: { [deck.id]: deck }
  };
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
    chatIdentityHash: hashJson('prose-runtime-chat'),
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
      async postProcessSourceIdentity() {
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
  storage: providedStorage = null
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
  if (settings.enhancements && typeof settings.enhancements === 'object') {
    let legacyEnhancements = clone(settings.enhancements);
    const canonicalGet = settingsStore.get.bind(settingsStore);
    const canonicalUpdate = settingsStore.update.bind(settingsStore);
    settingsStore.get = () => ({ ...canonicalGet(), enhancements: clone(legacyEnhancements) });
    settingsStore.update = (patch = {}) => {
      if (patch.enhancements && typeof patch.enhancements === 'object') {
        legacyEnhancements = { ...legacyEnhancements, ...clone(patch.enhancements) };
      }
      const { enhancements: ignoredEnhancements, ...canonicalPatch } = patch;
      return { ...canonicalUpdate(canonicalPatch), enhancements: clone(legacyEnhancements) };
    };
  }
  const explicitProviders = settings.providers && typeof settings.providers === 'object'
    ? settings.providers
    : {};
  const profileDefaults = {};
  for (const lane of ['utility', 'reasoner']) {
    if (!Object.prototype.hasOwnProperty.call(explicitProviders?.[lane] || {}, 'connectionProfileId')) {
      profileDefaults[lane] = { connectionProfileId: `${lane}-profile` };
    }
  }
  if (Object.keys(profileDefaults).length) settingsStore.update({ providers: profileDefaults });
  for (const lane of ['utility', 'reasoner']) {
    const provider = settingsStore.get().providers[lane];
    if (!provider.connectionProfileId || provider.certification?.status !== 'not-run') continue;
    const certification = settingsStore.recordProviderCertification(lane, {
      status: 'pass',
      checkedAt: '2026-07-17T00:00:00.000Z',
      completionMode: 'chat',
      structuredOutput: 'prompt-json',
      checks: { connectivity: 'pass', singleCard: 'pass', fusedCards: 'pass' },
      safeConcurrency: 1,
      diagnosticCodes: []
    }, {
      configHash: providerConfigHash(provider),
      configRevision: provider.configRevision
    });
    assertEqual(certification.ok, true, `runtime harness records hash-bound ${lane} certification`);
  }
  const rawGenerationRouter = generationRouter === undefined ? localFallbackCardRouter() : generationRouter;
  const resolvedGenerationRouter = rawGenerationRouter && typeof rawGenerationRouter.batch === 'function'
    ? {
        ...rawGenerationRouter,
        async generate(roleId, request = {}, options = {}) {
          if (roleId.endsWith('Card')) {
            const responses = await rawGenerationRouter.batch.call(
              rawGenerationRouter,
              [{ ...request, roleId }],
              options
            );
            return Array.isArray(responses) ? responses[0] : responses;
          }
          return rawGenerationRouter.generate.call(rawGenerationRouter, roleId, request, options);
        }
      }
    : rawGenerationRouter;
  const host = {
    providerProfiles: {
      list() {
        return ['utility', 'reasoner'].map((lane) => {
          const id = settingsStore.get().providers[lane].connectionProfileId;
          return id ? { id, name: `${lane} profile`, label: `${lane} profile`, completionMode: 'chat' } : null;
        }).filter(Boolean);
      }
    },
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
  const runtime = createRecursionRuntime({
    host,
    settingsStore,
    storage,
    activity,
    generationRouter: resolvedGenerationRouter
  });
  return { runtime, calls, installed, cleared, storage, settingsStore, activity, adapter };
}

for (const hostExcluded of [false, true]) {
  for (const mutateSource of [false, true]) {
    let reads = 0;
    const requests = [];
    const fallbackRouter = localFallbackCardRouter();
    const sourceMessages = [
      { mesid: 11, role: 'user', text: 'Continue the scene.', visible: true },
      { mesid: 12, role: 'assistant', text: 'Preserve this earlier assistant.', visible: true }
    ];
    const { runtime, calls } = createRuntimeHarness({
      settings: { reasoningLevel: 'medium', reasonerUse: 'always', providers: {
        utility: { outputTokenCeiling: 16384 }, reasoner: { outputTokenCeiling: 24576 }
      } },
      snapshot() {
        reads += 1;
        const messages = clone(sourceMessages);
        if (mutateSource && reads > 1) messages[1].text = 'A genuine source edit.';
        if (!hostExcluded) messages.push({ mesid: 13, role: 'assistant', text: 'Replace only this assistant.', visible: true });
        return { chatId: 'canonical-swipe', sceneKey: 'scene', sceneFingerprint: 'scene', messages,
          latestMesId: hostExcluded ? 12 : 13, latestAssistantExcluded: hostExcluded };
      },
      generationRouter: {
        async generate(roleId, request) {
          requests.push({ roleId, request });
          return fallbackRouter.generate(roleId, request);
        }
      }
    });
    const prepared = await runtime.prepareForGeneration({ generationType: 'swipe', hostGeneration: true });
    assertEqual(calls.install, mutateSource ? 0 : 1, `swipe installs only unchanged canonical source (hostExcluded=${hostExcluded}, mutation=${mutateSource})`);
    assertEqual(prepared.recursionPromptInstalled, !mutateSource, 'swipe result reports the actual prompt install');
    assertEqual(prepared.packet.diagnostics.reasonerStatus, 'used', 'durable packet reports the completed Reasoner guidance');
    const arbiter = requests.find(({ roleId }) => roleId === 'utilityArbiter');
    assert(arbiter.request.prompt.includes('Preserve this earlier assistant.'), 'swipe source retains the preceding assistant');
    const guidance = requests.find(({ roleId }) => roleId === 'guidanceComposer');
    assertEqual(guidance.request.lane, 'reasoner', 'medium durable guidance uses the Reasoner');
    assertEqual(guidance.request.reasoningIntent, 'medium', 'durable guidance carries requested reasoning intent');
    assertEqual(arbiter.request.providerConfig?.outputTokenCeiling, 16384, 'durable Utility request carries configured ceiling for retry budgeting');
    assertEqual(guidance.request.providerConfig?.outputTokenCeiling, 24576, 'durable Reasoner request carries its own configured ceiling');
  }
}

function localFallbackCardRouter(diagnostics = ['unit-local-fallback-cards']) {
  return {
    async generate(roleId, request) {
      if (CARD_CATALOG.some((entry) => entry.role === roleId)) return cardProviderResponse(roleId, request);
      if (roleId === 'guidanceComposer') {
        return {
          ok: true,
          data: {
            schema: 'recursion.guidanceComposer.v1',
            snapshotHash: request.snapshotHash,
            guidanceText: 'Follow the selected Recursion cards while preserving the current turn.',
            sourceCardIds: request.sourceCardIds || [],
            guardrailCardIds: [],
            omittedCardIds: [],
            diagnostics: ['unit-guidance']
          }
        };
      }
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

function createLivePostProcessRuntimeHarness({
  chatId = 'Folder / Active Chat?! File.jsonl',
  getCurrentChatId = null,
  chatMetadata = null,
  characterId = '',
  groupId = '',
  applyMode = 'as-swipe',
  originalText = 'Original live Post-process response.',
  swipes = [originalText],
  swipeId = 0,
  writer = async () => 'Rewritten live Post-process response.'
} = {}) {
  const writerCalls = [];
  const routerCalls = [];
  const saveCalls = [];
  const updateCalls = [];
  const promptCalls = [];
  const initialSwipes = [...swipes];
  const context = {
    characterId,
    groupId,
    chat: [
      { mesid: 7, is_user: true, mes: 'Continue the live scene.' },
      {
        mesid: 8,
        is_user: false,
        mes: initialSwipes[swipeId] ?? originalText,
        swipe_id: swipeId,
        swipes: initialSwipes,
        swipe_info: initialSwipes.map(() => ({
          send_date: '2026-07-19T00:00:00.000Z',
          extra: {}
        }))
      }
    ],
    extension_prompt_types: { IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 },
    extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
    setExtensionPrompt(...args) {
      promptCalls.push(args);
    },
    async generate(type, options) {
      writerCalls.push({ type, options });
      return writer({ context, type, options, callIndex: writerCalls.length - 1 });
    },
    async saveChat() {
      saveCalls.push(true);
    },
    updateMessageBlock(messageId, message) {
      updateCalls.push({ messageId, message });
    },
    swipe: {
      refresh() {}
    }
  };
  if (chatId !== null) context.chatId = chatId;
  if (typeof getCurrentChatId === 'function') context.getCurrentChatId = getCurrentChatId;
  if (chatMetadata && typeof chatMetadata === 'object') context.chatMetadata = chatMetadata;
  const host = createSillyTavernHost({
    contextFactory: () => context,
    settingsRoot: {}
  });
  host.settingsStore.update({
    reasoningLevel: 'medium',
    postProcess: {
      enabled: true,
      applyMode,
      rewriteFlow: 'unified',
      contextMessages: 13
    }
  });
  const generationRouter = {
    async generate(roleId, request, options) {
      routerCalls.push({ roleId, request, options });
      return {
        ok: true,
        roleId,
        lane: request.lane,
        data: {
          schema: 'recursion.postProcessGuidance.v1',
          snapshotHash: request.snapshotHash,
          sourceHash: request.sourceHash,
          guidanceText: 'Apply the frozen live Post-process guidance.'
        },
        diagnostics: { retryCount: 0 }
      };
    }
  };
  const runtime = createRecursionRuntime({
    host,
    settingsStore: host.settingsStore,
    generationRouter
  });
  return {
    context,
    host,
    runtime,
    writerCalls,
    routerCalls,
    saveCalls,
    updateCalls,
    promptCalls,
    assistant: () => context.chat[1]
  };
}

{
  const proseHost = createProseMessageHarness('Original runtime post-process response.');
  const routerCalls = [];
  const writerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: {
      reasoningLevel: 'medium',
      postProcess: {
        enabled: true,
        applyMode: 'as-swipe',
        rewriteFlow: 'unified',
        contextMessages: 13
      }
    },
    snapshot: {
      chatId: 'prose-runtime-chat',
      chatKey: 'prose-runtime-chat',
      chatIdentityHash: hashJson('prose-runtime-chat'),
      sceneKey: 'prose-runtime-scene',
      sceneFingerprint: 'prose-runtime-scene-fp',
      sourceRevisionHash: 'prose-runtime-source',
      turnFingerprint: 'prose-runtime-turn',
      latestMesId: 8,
      messages: [
        { mesid: 7, role: 'user', text: 'Continue the scene.', visible: true },
        {
          mesid: 8,
          role: 'assistant',
          text: 'Original runtime post-process response.',
          swipeId: 0,
          swipeCount: 1,
          activeSwipeTextHash: hashJson('Original runtime post-process response.'),
          visible: true
        }
      ]
    },
    hostMessages: proseHost.messages,
    hostGeneration: {
      async rewriteWithPostProcess(input) {
        writerCalls.push(input);
        return { ok: true, text: 'Runtime delegated post-process response.' };
      }
    },
    generationRouter: {
      async generate(roleId, request, options) {
        routerCalls.push({ roleId, request, options });
        return {
          ok: true,
          roleId,
          lane: request.lane,
          data: {
            schema: 'recursion.postProcessGuidance.v1',
            snapshotHash: request.snapshotHash,
            sourceHash: request.sourceHash,
            guidanceText: 'Apply the selected Post-process cards.'
          },
          diagnostics: { retryCount: 0 }
        };
      }
    }
  });

  for (const method of [
    'preparePostProcessTrigger',
    'postProcessPending',
    'postProcessRunning',
    'runPostProcessForLatestAssistant',
    'cancelPostProcess',
    'waitForPostProcessSettlement',
    'postProcessFinalTargetReady',
    'postProcessHostRunReady',
    'postProcessDiagnostics'
  ]) {
    assertEqual(typeof runtime[method], 'function', `runtime delegates ${method}`);
  }
  const result = await runtime.runPostProcessForLatestAssistant();
  assertEqual(result.committed, true, 'delegated Post-process runtime commits');
  assertEqual(routerCalls.length, 1, 'delegated runtime makes one Unified guidance call');
  assertEqual(writerCalls.length, 1, 'delegated runtime makes one Unified host rewrite');
  assertEqual(
    proseHost.calls.filter((call) => call.type === 'append').length,
    1,
    'delegated runtime commits one final swipe through the existing host boundary'
  );
  assertEqual(runtime.postProcessRunning(), false, 'delegated runtime clears running state');
  assertEqual(runtime.postProcessPending(), false, 'delegated runtime clears pending state');
  assert(
    !JSON.stringify(runtime.postProcessDiagnostics()).includes('Runtime delegated post-process response.'),
    'delegated runtime diagnostics omit candidate prose'
  );
}

{
  const live = createLivePostProcessRuntimeHarness({
    chatId: 'post-process-trigger-chat'
  });
  await live.runtime.prepareForGeneration({
    userMessage: 'Arm Post-process for the next host response.',
    hostGeneration: true,
    generationType: 'normal'
  });
  assertEqual(live.runtime.postProcessPending(), true, 'host generation preparation arms Post-process exactly once');
  const canceled = live.runtime.cancelPostProcess('source-edited');
  assertEqual(canceled.canceled, true, 'source mutation can cancel a pending Post-process operation');
  assertEqual(live.runtime.postProcessPending(), false, 'cancel clears the pending Post-process arm');
}

{
  const writerGate = deferred();
  const live = createLivePostProcessRuntimeHarness({
    chatId: 'post-process-immediate-next-generation',
    writer: async () => writerGate.promise
  });
  const firstRun = live.runtime.runPostProcessForLatestAssistant();
  await waitUntil(() => live.writerCalls.length === 1, 'delayed prior Post-process writer did not start');
  let nextPreparationSettled = false;
  const nextPreparation = live.runtime.prepareForGeneration({
    userMessage: 'Begin the immediate next host generation.',
    hostGeneration: true,
    generationType: 'normal'
  }).then((result) => {
    nextPreparationSettled = true;
    return result;
  });
  await Promise.resolve();
  assertEqual(nextPreparationSettled, false, 'next generation waits for canceled Post-process settlement before arming');
  writerGate.resolve('Canceled prior candidate must not commit.');
  const priorResult = await firstRun;
  await nextPreparation;
  assertEqual(priorResult.committed, false, 'canceled prior Post-process operation cannot commit');
  assertEqual(priorResult.paused, true, 'canceled durable Post-process operation settles paused for explicit recovery');
  assertEqual(priorResult.execution.pauseReason, 'post-process-stopped', 'paused prior operation records the stable stop reason');
  assertEqual(live.runtime.postProcessPending(), true, 'immediate next generation reliably arms after prior cancellation settles');
  assertEqual(live.assistant().swipes.length, 1, 'canceled prior operation leaves the assistant response unchanged');
}

{
  const live = createLivePostProcessRuntimeHarness();
  const result = await live.runtime.runPostProcessForLatestAssistant();
  assertEqual(result.committed, true, 'real runtime guard accepts an unchanged source with spaces and punctuation in its chat id');
  assertEqual(live.assistant().swipes.length, 2, 'unchanged punctuation chat commits through the real host swipe boundary');
  assertEqual(live.saveCalls.length, 1, 'unchanged punctuation chat saves exactly one committed swipe');
  const committedMarker = live.assistant().__recursionPostProcessSwipes[1];
  assertEqual(committedMarker.schema, 'recursion.postProcessMarker.v1', 'real runtime persists the Post-process V1 marker');
  assertEqual(committedMarker.sourceHash, hashJson('Original live Post-process response.'), 'real runtime marker binds to actual source text');
  assertEqual(committedMarker.candidateHash, hashJson('Rewritten live Post-process response.'), 'real runtime marker binds to actual candidate text');
  assert(!JSON.stringify(committedMarker).includes('Original live Post-process response.'), 'real runtime marker omits source prose');
  assert(!JSON.stringify(committedMarker).includes('Rewritten live Post-process response.'), 'real runtime marker omits candidate prose');
}

{
  const writerGate = deferred();
  const live = createLivePostProcessRuntimeHarness({
    chatId: 'Folder/Chat.jsonl',
    writer: async () => writerGate.promise
  });
  const originalSwipes = clone(live.assistant().swipes);
  const run = live.runtime.runPostProcessForLatestAssistant();
  await waitUntil(() => live.writerCalls.length === 1, 'real chat-staleness writer did not start');
  live.context.chatId = 'Folder Chat.jsonl';
  writerGate.resolve('Candidate from the old chat.');
  const result = await run;
  assertEqual(result.committed, false, 'real runtime guard rejects chat ids that collide after safeId canonicalization');
  assertEqual(
    result.reason || result.diagnostics?.reason,
    'stage-failed:postprocess-host-commit',
    'lossy chat-key collision fails at the durable host-commit boundary'
  );
  assertDeepEqual(live.assistant().swipes, originalSwipes, 'lossy chat-key collision preserves every source swipe');
  assertEqual(live.saveCalls.length, 0, 'lossy chat-key collision never reaches the host commit boundary');
}

for (const applyMode of ['as-swipe', 'replace']) {
  for (const mutation of ['edit', 'swipe', 'delete', 'chat-change', 'stop']) {
    const commitGate = deferred();
    let commitBoundaryStarted = false;
    let getterCalls = 0;
    let resolvedChatId = `outer-guard-${applyMode}-${mutation}`;
    const live = createLivePostProcessRuntimeHarness({
      chatId: null,
      applyMode,
      getCurrentChatId: async () => {
        getterCalls += 1;
        if (getterCalls >= 4) {
          commitBoundaryStarted = true;
          await commitGate.promise;
        }
        return resolvedChatId;
      },
      writer: async () => `Outer guard ${applyMode} candidate.`
    });
    const originalAssistant = live.assistant();
    const originalSwipes = clone(originalAssistant.swipes);
    const run = live.runtime.runPostProcessForLatestAssistant();
    await waitUntil(
      () => commitBoundaryStarted,
      `${applyMode} ${mutation} did not reach host commit after outer guard`
    );
    assert(getterCalls >= 4, `${applyMode} ${mutation} resolves snapshot, capture, and outer guard before host commit gate`);
    if (mutation === 'edit') {
      originalAssistant.mes = 'Edited inside the host commit window.';
      originalAssistant.swipes[originalAssistant.swipe_id] = originalAssistant.mes;
    } else if (mutation === 'swipe') {
      originalAssistant.swipes.push('Swiped inside the host commit window.');
      originalAssistant.swipe_info.push({ extra: {} });
      originalAssistant.swipe_id = originalAssistant.swipes.length - 1;
      originalAssistant.mes = originalAssistant.swipes[originalAssistant.swipe_id];
    } else if (mutation === 'delete') {
      live.context.chat.splice(1, 1);
    } else if (mutation === 'chat-change') {
      resolvedChatId = `changed-${resolvedChatId}`;
    } else {
      live.runtime.cancelPostProcess('stop-during-host-commit');
    }
    commitGate.resolve();
    const result = await run;
    assertEqual(result.committed, false, `${applyMode} ${mutation} cannot commit after the outer guard`);
    assertEqual(
      live.saveCalls.length,
      0,
      `${applyMode} ${mutation} performs no host response save`
    );
    assert(!originalAssistant.swipes.includes(`Outer guard ${applyMode} candidate.`), `${applyMode} ${mutation} appends no candidate`);
    assert(originalAssistant.mes !== `Outer guard ${applyMode} candidate.`, `${applyMode} ${mutation} replaces no candidate`);
    if (mutation === 'stop') {
      assertDeepEqual(originalAssistant.swipes, originalSwipes, `${applyMode} Stop preserves the exact source swipe array`);
    }
  }
}

{
  const getterOnlyChatId = 'Getter/Only Runtime Chat.jsonl';
  const live = createLivePostProcessRuntimeHarness({
    chatId: null,
    getCurrentChatId: async () => getterOnlyChatId
  });
  const result = await live.runtime.runPostProcessForLatestAssistant();
  assertEqual(result.committed, true, 'real runtime guard accepts an unchanged getter-only chat');
  assertEqual(live.saveCalls.length, 1, 'getter-only source identity reaches exactly one host commit');
  assert(!JSON.stringify(result.diagnostics).includes(getterOnlyChatId), 'getter-only raw chat id is absent from Post-process diagnostics');
}

{
  const getterPreferredChatId = 'Getter/Preferred Runtime Chat.jsonl';
  const conflictingMetadataChatId = 'Metadata/Conflicting Runtime Chat.jsonl';
  const live = createLivePostProcessRuntimeHarness({
    chatId: null,
    getCurrentChatId: async () => getterPreferredChatId,
    chatMetadata: { chat_id: conflictingMetadataChatId }
  });
  const result = await live.runtime.runPostProcessForLatestAssistant();
  assertEqual(result.committed, true, 'real runtime guard shares snapshot getter-over-metadata precedence');
  assertEqual(live.saveCalls.length, 1, 'getter-preferred source identity reaches exactly one host commit');
  const serializedDiagnostics = JSON.stringify(result.diagnostics);
  assert(!serializedDiagnostics.includes(getterPreferredChatId), 'getter-preferred raw chat id is absent from Post-process diagnostics');
  assert(!serializedDiagnostics.includes(conflictingMetadataChatId), 'conflicting metadata chat id is absent from Post-process diagnostics');
}

{
  const writerGate = deferred();
  const live = createLivePostProcessRuntimeHarness({
    chatId: 'character-staleness-chat',
    characterId: 'character-a',
    writer: async () => writerGate.promise
  });
  const originalSwipes = clone(live.assistant().swipes);
  const run = live.runtime.runPostProcessForLatestAssistant();
  await waitUntil(() => live.writerCalls.length === 1, 'real character-staleness writer did not start');
  live.context.characterId = 'character-b';
  writerGate.resolve('Candidate from the old character.');
  const result = await run;
  assertEqual(result.committed, false, 'real runtime guard rejects an active character change');
  assertEqual(result.diagnostics?.reason, 'stage-failed:postprocess-host-commit', 'active character change fails the durable host-commit stage');
  assertDeepEqual(live.assistant().swipes, originalSwipes, 'active character change preserves every source swipe');
  assertEqual(live.saveCalls.length, 0, 'active character change never reaches the host commit boundary');
}

{
  const writerGate = deferred();
  const live = createLivePostProcessRuntimeHarness({
    chatId: 'group-staleness-chat',
    groupId: 'group-a',
    writer: async () => writerGate.promise
  });
  const originalSwipes = clone(live.assistant().swipes);
  const run = live.runtime.runPostProcessForLatestAssistant();
  await waitUntil(() => live.writerCalls.length === 1, 'real group-staleness writer did not start');
  live.context.groupId = 'group-b';
  writerGate.resolve('Candidate from the old group.');
  const result = await run;
  assertEqual(result.committed, false, 'real runtime guard rejects an active group change');
  assertEqual(result.diagnostics?.reason, 'stage-failed:postprocess-host-commit', 'active group change fails the durable host-commit stage');
  assertDeepEqual(live.assistant().swipes, originalSwipes, 'active group change preserves every source swipe');
  assertEqual(live.saveCalls.length, 0, 'active group change never reaches the host commit boundary');
}

{
  const originalText = 'Selected source text for default Replace.';
  const live = createLivePostProcessRuntimeHarness({
    chatId: 'replace-boundary-chat',
    applyMode: 'replace',
    originalText,
    swipes: ['Earlier alternate text.', originalText],
    swipeId: 1,
    writer: async () => 'In-place replacement from the real runtime boundary.'
  });
  const originalSwipeCount = live.assistant().swipes.length;
  const originalSwipeId = live.assistant().swipe_id;
  const result = await live.runtime.runPostProcessForLatestAssistant();
  assertEqual(result.committed, true, 'complete real-host run commits the requested Replace mode');
  assertEqual(result.committedApplyMode, 'replace', 'default commit boundary reports Replace');
  assertEqual(live.assistant().mes, 'In-place replacement from the real runtime boundary.', 'Replace updates visible selected assistant text in place');
  assertEqual(live.assistant().swipes[originalSwipeId], live.assistant().mes, 'Replace updates the selected swipe text in place');
  assertEqual(live.assistant().swipes.length, originalSwipeCount, 'Replace preserves the source swipe count');
  assertEqual(live.assistant().swipe_id, originalSwipeId, 'Replace preserves the selected swipe index');
  assertEqual(live.saveCalls.length, 1, 'Replace saves exactly one host mutation');
  assertEqual(live.assistant().__recursionPostProcess.committedApplyMode, 'replace', 'Replace persists one Post-process replacement marker');
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
  preProcessDecks: {
    activeDeckId: 'eligibility-deck',
    customDecks: {
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
changedEligibilitySettings.preProcessDecks.customDecks['eligibility-deck'].cards['active-card'].selectionState = 'off';
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
    settings: fusedReadyReasonerSettings({
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
    settings: fusedReadyReasonerSettings({
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
    settings: fusedReadyReasonerSettings({
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


}

{
  const proseHost = createProseMessageHarness('Mara crossed the room. "Keep the door shut," Mara said.');
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { enhancements: { target: 'on', applyMode: 'as-swipe', contextMessages: 3 } },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate(roleId, request, options = {}) {
        routerCalls.push({ roleId, request, options });
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
  assertEqual(routerCalls[0].options.timeoutMs ?? null, null, 'generation review has no Recursion-owned timeout');
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
  assertEqual(result.ok, false, 'review with no valid patch remains failed after semantic correction');
  assertEqual(routerCalls.length, 2, 'runtime semantic correction is visible as a second single-attempt router call');
}

for (const pipelineMode of ['segmented', 'fused']) {
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

for (const pipelineMode of ['segmented', 'fused']) {
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
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'Preserve the prepared hand while reviewing the response.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['generation-review-guidance']
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

// Direct endpoint model discovery was removed; Connection Profiles own model selection.

function immediateDurableCardRouter() {
  return {
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
            cardJobs: [{
              family: 'Scene Frame',
              role: 'sceneFrameCard',
              reason: 'Preserve the current scene.'
            }],
            budgets: { targetBriefTokens: 500, maxCards: 4 },
            reasonerDecision: { mode: 'skip', reason: 'runtime reset fixture', signals: [] },
            diagnostics: []
          }
        };
      }
      if (roleId === 'sceneFrameCard') {
        return {
          ok: true,
          roleId,
          data: {
            schema: 'recursion.card.v1',
            family: 'Scene Frame',
            role: roleId,
            snapshotHash: request.snapshotHash,
            items: [{
              promptText: 'Keep the current scene grounded in visible evidence.',
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
            guidanceText: 'Keep the reply grounded in the current scene.',
            sourceCardIds: [],
            guardrailCardIds: [],
            omittedCardIds: [],
            diagnostics: []
          }
        };
      }
      throw new Error(`Unexpected durable provider role ${roleId}`);
    }
  };
}

{
  const roleCalls = [];
  const hostStartCalls = [];
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'segmented', mode: 'auto', reasonerUse: 'off' },
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

  const update = await harness.runtime.updateSettings({ pipelineMode: 'fused' });
  assertEqual(update.ok, true, 'switching to Fused succeeds');
  assertEqual(update.settings.pipelineMode, 'fused', 'settings update records Fused pipeline');
  assertDeepEqual(roleCalls, [], 'switching pipeline does not call providers');
  assertDeepEqual(hostStartCalls, [], 'switching pipeline does not start host generation');
  assertEqual(harness.runtime.view().settings.pipelineMode, 'fused', 'runtime view shows the selected next pipeline');
}

{
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'segmented', mode: 'auto', reasonerUse: 'off' }
  });

  const beforeClearCount = harness.calls.clear;
  const result = await harness.runtime.updateSettings({ pipelineMode: 'segmented' });
  assertEqual(result.ok, true, 'selecting the current pipeline succeeds');
  assertEqual(harness.calls.clear, beforeClearCount, 'selecting the current pipeline does not clear the prompt');
}

{
  const roleCalls = [];
  const harness = createRuntimeHarness({
    settings: { modelAttemptsPerStep: 2 },
    generationRouter: {
      async generate(roleId) {
        roleCalls.push(roleId);
        throw new Error(`attempt setting should not call provider role ${roleId}`);
      }
    }
  });
  const update = await harness.runtime.updateSettings({ modelAttemptsPerStep: 4 });
  assertEqual(update.ok, true, 'updating Attempts per step succeeds');
  assertEqual(update.settings.modelAttemptsPerStep, 4, 'runtime stores the normalized attempt limit');
  assertDeepEqual(roleCalls, [], 'updating Attempts per step does not start a provider call');
}

{
  const roleCalls = [];
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'segmented', mode: 'auto', reasonerUse: 'off' },
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
              guidanceText: 'Use the newly selected Segmented path.',
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
    messages,
    sourceWindowTruncated: false,
    sourceWindowLimitReason: ''
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
  assertEqual(second.ok, true, 'overlapping Editorial swipe completes from the retained operation');
  assertEqual(finalPipelineCalls, initialPipelineCalls, 'overlapping Editorial swipe makes no new Arbiter, Fused, or Guidance calls');
  assertEqual(installed.at(-1)?.packetId, initialPacketId, 'overlapping Editorial swipe preserves packet identity');
  assertEqual(appendCount, 0, 'aborted Editorial work appends no enhancement swipe');
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
    settings: { pipelineMode: 'segmented', mode: 'auto', reasonerUse: 'off' },
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
  const queued = await runtime.queueFullFreshSwipe({ source: 'bar' });
  assertEqual(queued.ok, true, 'fresh latest assistant queues after swipe marker');
  assertEqual(runtime.view().lastBrief?.status, 'ready', 'fresh latest assistant arming keeps Last Brief ready before generation');
  const second = await runtime.prepareForGeneration({
    userMessage: null,
    hostGeneration: true,
    generationType: 'swipe'
  });
  assertEqual(second.ok, true, 'fresh latest assistant run succeeds');
  assert(providerCalls > callsAfterFirst, 'fresh latest assistant run calls providers again');
  assertEqual(installed.length, 2, 'fresh latest assistant installs a second packet');
  assertNotEqual(installed[0].packetId, installed[1].packetId, 'fresh latest assistant changes packet identity');
  assertEqual(runtime.view().lastSnapshot.latestMesId, 20, 'fresh latest assistant rebuilds from the turn source before the swiped response');
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
  assertEqual(during.lastBrief?.status, 'historical', 'Last Brief becomes inspection-only as soon as a new send starts');
  assertEqual(during.lastBrief?.reason, 'new-user-turn', 'new send records the turn boundary');
  assertEqual(during.lastBriefHand?.cards.length, firstView.lastHand.cards.length, 'new send retains historical Last Brief cards for inspection');
  assertEqual(during.lastBriefPacket?.packetId, firstView.lastBrief.packetId, 'new send retains the historical Last Brief packet for inspection');
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
  assertEqual(result.ok, false, 'missing Utility router does not complete the durable operation');
  assertEqual(result.paused, true, 'missing Utility router pauses the durable operation');
  assertEqual(installed.length, 0, 'missing Utility router does not install prompt');
  assertEqual(cleared.length, 0, 'missing Utility router does not perform unrelated prompt cleanup');
  assertEqual(view.execution.state, 'paused', 'missing Utility router remains visible as paused work');
  assertEqual(view.execution.pauseReason, 'stage-failed:preprocess.arbiter', 'missing Utility router exposes the failed Arbiter stage');
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
  assertEqual(result.ok, false, 'Utility failure does not complete the durable operation');
  assertEqual(result.paused, true, 'Utility failure pauses for an explicit retry');
  assertEqual(installed.length, 0, 'Utility unavailable without cache does not install prompt');
  assertEqual(cleared.length, 0, 'Utility failure does not perform unrelated prompt cleanup');
  assertEqual(view.execution.state, 'paused', 'Utility failure remains visible as paused work');
  assertEqual(view.execution.pauseReason, 'stage-failed:preprocess.arbiter', 'Utility failure exposes the failed Arbiter stage');
  assert(!serialized.includes('Bearer utility-token'), 'Utility unavailable reason redacts bearer token');
  assert(!serialized.includes('sk-utility-runtime'), 'Utility unavailable reason redacts sk token');
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
  const { runtime, calls, installed, storage } = createRuntimeHarness({
    settings: { mode: 'manual', reasonerUse: 'off' }
  });
  const result = await runtime.prepareForGeneration({
    userMessage: 'Manual with Bearer live-token, sk-live-runtime, and private-secret.'
  });
  const view = runtime.view();
  assertEqual(result.ok, true, 'manual mode returns ok');
  assertEqual(result.observe, undefined, 'manual is not an observe-only preview path');
  assertEqual(calls.snapshot, 2, 'manual reads the source and rechecks once before prompt installation');
  assertEqual(installed.length, 1, 'manual installs one prompt through the scoped pipeline');
  assert(view.lastPacket, 'manual builds packet');
  assert(view.lastHand.cards.length > 0, 'manual builds hand');
  assertEqual(view.activity.label, 'Recursion prompt ready.', 'manual activity settles as prompt ready');
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
  settingsStore.updateProviderConfig('utility', {
    connectionProfileId: 'preserved-profile',
    generationPolicy: {
      presetMode: 'isolated',
      instructMode: 'auto',
      samplerMode: 'profile',
      structuredOutputMode: 'prompt-json'
    }
  });
  const reset = runtime.resetSettingsMenu();
  await waitUntil(() => typeof releaseClear === 'function', 'settings reset did not start prompt clear');
  assertEqual(runtime.view().settings.strength, 'balanced', 'settings reset restores Play settings immediately');
  assertEqual(runtime.view().settings.injection.depth, 1, 'settings reset restores Advanced settings immediately');
  assertEqual(runtime.view().settings.enabled, false, 'settings reset preserves compact-bar enabled state');
  assertEqual(runtime.view().settings.mode, 'manual', 'settings reset preserves compact-bar mode');
  assertEqual(runtime.view().settings.providers.utility.connectionProfileId, 'preserved-profile', 'settings reset preserves provider profile');
  assertEqual(runtime.view().settings.providers.utility.generationPolicy.structuredOutputMode, 'prompt-json', 'settings reset preserves provider generation policy');
  releaseClear();
  const result = await reset;
  assertEqual(result.ok, true, 'settings reset returns success after prompt clear');
  assertEqual(result.reset, true, 'settings reset reports that values changed');
  assertEqual(result.clear.ok, true, 'settings reset returns prompt clear result');
  assertEqual(calls.clear, 1, 'settings reset clears host prompt once');
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
  assertEqual(Object.hasOwn(view.settings.preProcessDecks, 'defaultEnabledState'), false, 'runtime view does not migrate legacy card scope state');
  assertEqual(
    view.settings.cardScopeSummary.counts.selectedSubItems,
    CARD_SCOPE_CATALOG.reduce((total, entry) => total + entry.subItems.length, 0),
    'runtime view derives the default Pre-process Deck scope when legacy scope input is ignored'
  );
}

{
  const disabledSceneScope = setFamilyEnabled(defaultCardScope(), 'Scene Frame', false).scope;
  const rawSettingsStore = createSettingsStore({ root: {} });
  const canonicalGet = rawSettingsStore.get.bind(rawSettingsStore);
  rawSettingsStore.get = () => {
    const { preProcessDecks: omittedPreProcessDecks, ...rawSettings } = canonicalGet();
    return { ...rawSettings, cardScope: disabledSceneScope };
  };
  const runtime = createRecursionRuntime({ settingsStore: rawSettingsStore });
  const view = runtime.view();
  assertEqual(
    view.settings.cardScopeSummary.counts.selectedSubItems,
    CARD_SCOPE_CATALOG.reduce((total, entry) => total + entry.subItems.length, 0),
    'runtime ignores legacy cardScope from a raw custom settings store and derives the default Pre-process Deck scope'
  );
  assertEqual(
    filterCardsForCardEligibility([{ id: 'raw-store-scene', family: 'Scene Frame' }], rawSettingsStore.get()).length,
    1,
    'runtime eligibility ignores legacy cardScope from a raw custom settings store and derives the default Pre-process Deck'
  );
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
  const expected = CARD_SCOPE_CATALOG.map((entry) => entry.family);
  assertDeepEqual(manualSelectedFamilies(activeCardDeckRuntimeScope(update.settings)), expected, 'Auto-to-Manual does not persist a legacy cardScope overlay');
  assertDeepEqual(manualSelectedFamilies(activeCardDeckRuntimeScope(runtime.view().settings)), expected, 'runtime view remains derived from the canonical Pre-process Deck');
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
  assertEqual(updatedScope.families['Scene Frame'].subItems[firstSceneFacet], true, 'legacy cardScope facets do not overlay the canonical Pre-process Deck');
  assertDeepEqual(
    manualSelectedFamilies(updatedScope),
    CARD_SCOPE_CATALOG.map((entry) => entry.family),
    'legacy selected families are ignored rather than migrated during Auto-to-Manual'
  );
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
  const update = Promise.resolve(runtime.updateProviderConfig('utility', {
    connectionProfileId: 'provider-change-profile',
    generationPolicy: {
      presetMode: 'isolated',
      instructMode: 'auto',
      samplerMode: 'recursion',
      structuredOutputMode: 'prompt-json'
    },
    samplerOverrides: { temperature: 0.25, topP: 0.85 },
    outputTokenCeiling: 4096
  }));
  update.then(() => {
    updateResolved = true;
  });
  await waitUntil(() => typeof releaseClear === 'function', 'provider settings change did not start prompt clear');
  assertEqual(updateResolved, false, 'provider settings change waits for prompt clear before resolving');
  assertEqual(settingsStore.get().providers.utility.connectionProfileId, 'provider-change-profile', 'provider settings change stores profile immediately');
  assertEqual(runtime.view().settings.providers.utility.generationPolicy.samplerMode, 'recursion', 'provider settings change updates policy immediately');
  assertEqual(runtime.view().activity.phase, 'promptClearing', 'provider settings change surfaces prompt clear activity');
  releaseClear();
  const result = await update;
  const view = runtime.view();
  assertEqual(result.ok, true, 'provider settings change returns success when prompt clear succeeds');
  assertEqual(result.provider.connectionProfileId, 'provider-change-profile', 'provider settings change returns updated profile');
  assertEqual(result.provider.certification.status, 'not-run', 'provider settings change invalidates certification');
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
  const first = runtime.updateProviderConfig('utility', {
    connectionProfileId: 'first-provider-profile'
  });
  await waitUntil(() => typeof releaseFirstClear === 'function', 'first provider clear did not start');
  const second = runtime.updateProviderConfig('utility', {
    connectionProfileId: 'second-provider-profile'
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
  const result = await runtime.updateProviderConfig('utility', {
    connectionProfileId: 'provider-fail-profile',
    generationPolicy: { instructMode: 'on' }
  });
  const view = runtime.view();
  assertEqual(result.ok, false, 'provider settings change returns non-ok when prompt clear fails');
  assertEqual(result.provider.connectionProfileId, 'provider-fail-profile', 'provider settings still apply when prompt clear fails');
  assertEqual(settingsStore.get().providers.utility.generationPolicy.instructMode, 'on', 'provider policy still applies when prompt clear fails');
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
  const update = runtime.updateProviderConfig('utility', {
    connectionProfileId: 'provider-test-race-profile'
  });
  await waitUntil(() => typeof releaseClear === 'function', 'provider test race clear did not start');
  const providerTest = await runtime.testProvider('utility');
  assertEqual(providerTest.ok, false, 'provider test without router fails for activity ownership regression');
  assertEqual(runtime.view().activity.label, 'Utility profile certification failed.', 'newer profile certification owns visible activity before older clear resolves');
  releaseClear();
  await update;
  assertEqual(runtime.view().activity.label, 'Utility profile certification failed.', 'older provider clear cannot overwrite newer profile certification activity');
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
  assertEqual(view.lastPreparedGeneration, null, 'initial prompt install failure does not commit a prepared generation artifact');
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
  assertEqual(result.install.ok, false, 'stale prompt install records a settled host failure');
  assertEqual(result.install.failureClass, 'host-source-stale', 'stale prompt install reports host source drift');
  assertEqual(calls.snapshot, 2, 'runtime rechecks host snapshot before prompt install');
  assertEqual(calls.install, 0, 'stale snapshot does not call host prompt install');
  assertEqual(installed.length, 0, 'stale snapshot does not write prompt packet');
  assertEqual(view.activity.severity, 'warning', 'stale install skip surfaces warning activity');
  assertEqual(view.activity.label, 'Prompt install failed. Generation will continue without Recursion.', 'stale install has visible warning status');
  const journal = await storage.loadRunJournal(firstTurn.chatKey);
  assertDeepEqual(journal.entries.map((entry) => entry.event), ['hand.selected', 'prompt.install_failed'], 'stale install is journaled after hand selection');
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
  assertEqual(result.install.ok, false, 'failed snapshot recheck settles prompt installation as failed');
  assertEqual(result.install.failureClass, 'host-source-stale', 'failed snapshot recheck reports bounded host-source failure');
  assertEqual(calls.snapshot, 2, 'failed recheck still attempts final host snapshot');
  assertEqual(calls.install, 0, 'failed snapshot recheck does not call host prompt install');
  assertEqual(installed.length, 0, 'failed snapshot recheck does not write prompt packet');
  assertEqual(view.activity.severity, 'warning', 'failed snapshot recheck surfaces warning activity');
  assertNoSecretText(result, 'snapshot recheck failure result');
  assertNoSecretText(view.activity, 'snapshot recheck failure activity');
  const journal = await storage.loadRunJournal(currentTurn.chatKey);
  assertDeepEqual(journal.entries.map((entry) => entry.event), ['hand.selected', 'prompt.install_failed'], 'failed snapshot recheck is journaled after hand selection');
  assertNoSecretText(journal.entries.at(-1), 'snapshot recheck failure journal');
}





{
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: fusedReadyReasonerSettings({ mode: 'auto', promptFootprint: 'rich', reasoningLevel: 'low' }),
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
    settings: fusedReadyReasonerSettings({ mode: 'auto', promptFootprint: 'normal', reasoningLevel: 'low' }),
    generationRouter: {
      async generate(roleId, request = {}) {
        routerCalls.push({ roleId, lane: request.lane || 'utility', reasoningIntent: request.reasoningIntent });
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
  assertEqual(routerCalls.find(call => call.roleId === 'utilityArbiter').reasoningIntent, 'minimal', 'utility planning explicitly limits reasoning');
}

for (const scenario of [
  { level: 'low', expectedMaxCards: 4 },
  { level: 'medium', expectedMaxCards: 8 },
  { level: 'high', expectedMaxCards: 8 },
  { level: 'ultra', expectedMaxCards: 12 }
]) {
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: fusedReadyReasonerSettings({
      mode: 'auto',
      promptFootprint: 'rich',
      reasoningLevel: scenario.level,
      minCards: 4,
      maxCards: 12
    }),
    generationRouter: {
      async generate(roleId, request = {}) {
        routerCalls.push({ roleId, lane: request.lane });
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
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: `${scenario.level} synthesis.`,
              sourceCardIds: request.sourceCardIds || [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['reasoning-card-budget-guidance']
            }
          };
        }
        return cardProviderResponse(roleId, request);
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: `Use custom ${scenario.level} card budget.` });
  const view = runtime.view();
  assertEqual(result.ok, true, `${scenario.level} custom card budget run installs`);
  assertEqual(view.lastPlan.budgets.maxCards, scenario.expectedMaxCards, `${scenario.level} reasoning uses configured card budget`);
  assertEqual(
    routerCalls.filter((call) => call.roleId === 'guidanceComposer' && call.lane === (scenario.level === 'low' ? 'utility' : 'reasoner')).length,
    1,
    `${scenario.level} custom card budget uses the configured guidance lane once`
  );
}

{
  const { runtime } = createRuntimeHarness({
    settings: fusedReadyReasonerSettings({
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




for (const scenario of [
  {
    label: 'failed reasoner test',
    settings: providerCertificationSettings({
      mode: 'auto',
      promptFootprint: 'rich'
    }, 'reasoner', 'fail'),
    expectedReason: 'reasoner-unhealthy'
  },
  {
    label: 'missing profile reasoner id',
    settings: {
      mode: 'auto',
      promptFootprint: 'rich',
      providers: {
        reasoner: {
          connectionProfileId: ''
        }
      }
    },
    expectedReason: 'provider-profile-missing'
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
  assert(arbiterPrompt.includes('The pending user turn should be visible to Recursion.'), 'arbiter prompt includes the pending user turn explicitly');
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
  assertEqual(calls.snapshot, 2, 'committed pending install reads the source and final install snapshot');
  assertEqual(installed.length, 1, 'committed pending user turn installs prompt');
  assert(JSON.stringify(installed[0]).includes(pendingText), 'installed prompt includes committed pending user turn');
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
  assertEqual(calls.snapshot, 2, 'hidden host bookkeeping uses the durable install recheck cadence');
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
    settings: providerCertificationSettings({
      mode: 'auto',
      strength: 'strong',
      focus: 'character',
      reasoningLevel: 'medium',
      promptFootprint: 'normal',
      reasonerUse: 'auto'
    }, 'utility', 'fail'),
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
  assert(!arbiterPrompts[0].includes('"health"'), 'arbiter prompt omits provider test diagnostics');
  assert(!arbiterPrompts[0].includes('connectionProfileId'), 'arbiter prompt omits provider configuration');
  assert(!arbiterPrompts[0].includes('compactError'), 'arbiter prompt omits provider compact errors');
  assert(!arbiterPrompts[0].includes('checkedAt'), 'arbiter prompt omits provider test timestamps');
  const providerHealth = parsePromptJsonSection(arbiterPrompts[0], 'Provider health');
  assertDeepEqual(providerHealth, {
    utility: { status: 'unhealthy', completionMode: 'chat', structuredOutput: 'prompt-json' },
    reasoner: { status: 'unconfigured', completionMode: 'unknown', structuredOutput: 'unknown' }
  }, 'arbiter provider capability prompt exposes only safe capability fields');
  assertNoSecretText(arbiterPrompts[0], 'arbiter settings prompt');
  assertNoSecretText(runtime.view().settings, 'runtime view settings');
  assertEqual(runtime.view().settings.reasoningLevel, 'medium', 'runtime view keeps reasoning level');
  assertEqual(Object.hasOwn(runtime.view().settings.providers.utility, 'enabled'), false, 'view omits retired provider enabled flag');
  assertEqual(runtime.view().settings.providers.utility.connectionProfileId, 'utility-profile', 'view keeps selected Utility profile');
  assertEqual(runtime.view().settings.providers.reasoner.connectionProfileId, '', 'view keeps unconfigured Reasoner profile empty');
  assertEqual(Object.hasOwn(runtime.view().settings.providers.utility, 'source'), false, 'view omits retired provider source');
  assertEqual(Object.hasOwn(runtime.view().settings.providers.reasoner, 'endpoint'), false, 'view omits transport configuration');
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
  assertEqual(result.ok, false, `${scenario.label} arbiter snapshot hash does not complete the durable operation`);
  assertEqual(result.paused, true, `${scenario.label} arbiter snapshot hash pauses for an explicit retry`);
  assertDeepEqual(
    routerCalls,
    ['utilityArbiter', 'utilityArbiter'],
    `${scenario.label} arbiter snapshot hash consumes only the bounded Arbiter attempt window`
  );
  assertEqual(result.execution.pauseReason, 'stage-failed:preprocess.arbiter', `${scenario.label} arbiter snapshot hash exposes the failed stage`);
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
  assert(view.lastPreparedGeneration, 'zero-card successful packet commits a prepared generation artifact');
  assertEqual(view.lastPreparedGeneration.hand.cards.length, 0, 'zero-card artifact remains valid without selected cards');
  await runtime.updateSettings({ enabled: false });
  assertEqual(runtime.view().lastPreparedGeneration, null, 'disabling Recursion hard-clears the prepared generation artifact');
}

{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' }
  });
  await runtime.prepareForGeneration({ userMessage: 'Prepare an artifact before teardown.' });
  assert(runtime.view().lastPreparedGeneration, 'teardown setup commits a prepared generation artifact');
  await runtime.dispose();
  assertEqual(runtime.view().lastPreparedGeneration, null, 'runtime teardown hard-clears the prepared generation artifact');
}

{
  let installAttempt = 0;
  const { runtime, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    hostPrompt: {
      async install() {
        installAttempt += 1;
        return installAttempt === 1
          ? { ok: true, installed: true }
          : { ok: false, error: { code: 'SECOND_INSTALL_FAILED', message: 'second install failed' } };
      }
    }
  });
  await runtime.prepareForGeneration({ userMessage: 'First prepared turn.' });
  const firstArtifact = clone(runtime.view().lastPreparedGeneration);
  assert(firstArtifact, 'first successful install establishes last-known-good artifact');
  await runtime.prepareForGeneration({
    userMessage: 'Second prepared turn.',
    refreshReason: 'atomic-install-failure-test'
  });
  assertEqual(runtime.view().lastPreparedGeneration, null, 'a failed new turn cannot retain prior generated authority');
  const historicalBrief = await storage.loadLastBrief('chat-1');
  assertEqual(historicalBrief.status, 'historical', 'the prior Last Brief remains display-only after the failed new turn');
  assertEqual(historicalBrief.packet.packetId, firstArtifact.packet.packetId, 'historical Last Brief retains the prior packet for inspection');
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
  assertEqual(result.ok, false, 'secret-bearing Arbiter error does not complete the durable operation');
  assertEqual(result.paused, true, 'secret-bearing Arbiter error pauses for explicit recovery');
  assert(serialized.includes('stage-failed:preprocess.arbiter'), 'Arbiter failure stage remains visible');
  assert(!serialized.includes('Bearer arbiter-token'), 'arbiter fallback reason redacts bearer token');
  assert(!serialized.includes('sk-arbiter-runtime'), 'arbiter fallback reason redacts sk token');
  assert(!serialized.includes('private-secret'), 'arbiter fallback reason redacts private secret');
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
              reasonerDecision: { mode: 'skip', reason: 'partial fused output', signals: [] },
              diagnostics: ['partial-fused-plan']
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
            lane: request.lane,
            data: {
              promptText: 'SEGMENTED_PARTIAL_REPAIR: keep the archive sealed until visible evidence changes it.',
              evidenceRefs: ['message:2']
            }
          };
        }
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'Use the valid partial fused output.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['partial-fused-guidance']
            }
          };
        }
        throw new Error(`unexpected partial fused role ${roleId}`);
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
  const result = await runtime.prepareForGeneration({ userMessage: 'Keep useful partial fused output.' });
  assertEqual(result.ok, true, 'Partial Fused output installs prompt');
  assertDeepEqual(
    roleCalls,
    ['utilityArbiter', 'fusedCardBundle', 'sceneConstraintsCard', 'guidanceComposer'],
    'Partial Fused output repairs only its unresolved family'
  );
  assert(result.packet.sections.cardEvidence.includes('FUSED_PARTIAL_VALID_SCENE'), 'valid fused sibling reaches packet');
  assert(result.packet.sections.cardEvidence.includes('SEGMENTED_PARTIAL_REPAIR'), 'targeted Segmented repair reaches packet');
  assertEqual(roleCalls.filter((roleId) => roleId === 'fusedCardBundle').length, 1, 'partial Fused output is not repeated');
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
                promptText: 'FUSED_FALLBACK_STANDARD_CARD: Segmented card fallback recovered.',
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
  assertEqual(fusedRequest.reasoningIntent, 'minimal', 'Utility Fused card bundle explicitly limits reasoning');
  assertDeepEqual(roleCalls, ['utilityArbiter', 'fusedCardBundle', 'fusedCardBundle', 'sceneFrameCard', 'guidanceComposer'], 'unusable Fused bundle exhausts its bounded attempts before Segmented fallback');
  assert(result.packet.sections.cardEvidence.includes('FUSED_FALLBACK_STANDARD_CARD'), 'Segmented fallback card reaches packet evidence');
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
                promptText: `${roleId === 'sceneFrameCard' ? 'FULL_FALLBACK_SCENE' : 'FULL_FALLBACK_CONSTRAINT'} recovered from full Segmented fallback.`,
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
      pipelineMode: 'segmented',
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
      pipelineMode: 'segmented',
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
        if (roleId === 'reasonerComposer') {
          return reasonerComposerResponse(request, 'Keep the budgeted generated card families only.');
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
  const manualNoScene = scopeWithOnlyFamilies(['Open Threads']);
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'manual', preProcessDecks: preProcessDecksForScope(manualNoScene), reasonerUse: 'off' },
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
  assert(serializedPlan.includes('inactive-card-ineligible'), 'manual Pre-process Deck diagnostics record an ineligible card omission');
}

{
  const manualForcedScope = scopeWithOnlyFamilies(['Scene Frame', 'Open Threads']);
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'manual', maxCards: 2, preProcessDecks: preProcessDecksForScope(manualForcedScope), reasonerUse: 'off' },
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
        if (roleId.endsWith('Card')) {
          return {
          ok: true,
          roleId,
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
          };
        }
        throw new Error(`unexpected Manual forced role ${roleId}`);
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
    settings: { mode: 'manual', maxCards: 2, preProcessDecks: preProcessDecksForScope(manualScope), reasonerUse: 'off' },
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
  const outcome = await runtime.prepareForGeneration({ userMessage: 'Manual forced failure.' });
  const view = runtime.view();
  assertEqual(outcome.ok, false, 'unresolved forced coverage blocks prompt installation');
  assertEqual(view.execution.stageRecords['preprocess.cards.segmented.open-threads'].state, 'completed', 'valid forced sibling remains checkpointed');
  assertEqual(view.execution.stageRecords['preprocess.cards.segmented.scene-frame'].state, 'failed', 'required failure remains visible');
  assertEqual(view.lastPacket, null, 'incomplete required coverage never reaches the primary prompt');
}

{
  const autoNoConstraints = scopeWithFamilyDisabled('Scene Constraints');
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', preProcessDecks: preProcessDecksForScope(autoNoConstraints), reasonerUse: 'off' },
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
          assert(!availableCatalog.some((entry) => entry.family === 'Scene Constraints'), 'Auto catalog excludes inactive Scene Constraints from hard deck eligibility');
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
        assertDeepEqual(requests, [], 'Auto Pre-process Deck eligibility filters an Off card before generation');
        return [];
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Auto focus.' });
  const view = runtime.view();
  const serializedPlan = JSON.stringify(view.lastPlan);
  assertEqual(result.ok, true, 'auto scoped run installs prompt');
  assert(!routerCalls.includes('sceneConstraintsCard'), 'auto Pre-process Deck run does not generate an Off card');
  assert(!view.lastHand.cards.some((card) => card.family === 'Scene Constraints'), 'auto Pre-process Deck hand excludes an Off card');
  assert(serializedPlan.includes('inactive-card-ineligible'), 'auto Pre-process Deck diagnostics record the filtered card');
  assert(!serializedPlan.includes('Do not contradict'), 'auto scope diagnostics do not include prompt text');
}

{
  const autoNoEnvironment = scopeWithFamilyDisabled('Environment');
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', preProcessDecks: preProcessDecksForScope(autoNoEnvironment), reasonerUse: 'off' },
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
        assertDeepEqual(requests, [], 'Auto Pre-process Deck eligibility filters an Off non-continuity card');
        return [];
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Auto non-continuity scope.' });
  const view = runtime.view();
  const serializedPlan = JSON.stringify(view.lastPlan);
  assertEqual(result.ok, true, 'auto scoped non-continuity run installs prompt');
  assert(!view.lastHand.cards.some((card) => card.family === 'Environment'), 'auto Pre-process Deck hand excludes an Off non-continuity card');
  assert(serializedPlan.includes('inactive-card-ineligible'), 'auto Pre-process Deck diagnostics record the non-continuity omission');
  assert(!serializedPlan.includes('Keep the response tight'), 'auto non-continuity diagnostics do not include prompt text');
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
  assertEqual(result.ok, false, 'invalid arbiter schema does not complete durable preprocessing');
  assertEqual(result.paused, true, 'invalid arbiter schema pauses for explicit retry');
  assertEqual(batchCalled, false, 'invalid arbiter schema does not execute provider card jobs');
  assertEqual(result.execution.pauseReason, 'stage-failed:preprocess.arbiter', 'invalid arbiter schema exposes the failed stage');
  assertEqual(view.lastHand.cards.length, 0, 'invalid arbiter schema does not create an untrusted hand');
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
  assertEqual(result.ok, false, 'missing arbiter schema does not complete durable preprocessing');
  assertEqual(result.paused, true, 'missing arbiter schema pauses for explicit retry');
  assertEqual(result.execution.pauseReason, 'stage-failed:preprocess.arbiter', 'missing arbiter schema exposes the failed stage');
  assert(!serialized.includes('Bearer missing-schema-token'), 'missing schema fallback does not leak rejected provider fields');
  assertNoSecretText(serialized, 'missing schema fallback');
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
  assertEqual(result.ok, false, 'arbiter exception does not complete durable preprocessing');
  assertEqual(result.paused, true, 'arbiter exception pauses the operation for retry');
  assertEqual(routerCalls.length, 1, 'unclassified arbiter failure stops without blind retry');
  assertEqual(result.execution.pauseReason, 'stage-failed:preprocess.arbiter', 'arbiter exception exposes the failed stage');
  assertEqual(view.lastPlan, null, 'failed Arbiter work never becomes the committed last plan');
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
  assertEqual(result.packet.chatId, 'chat', 'packet gets normalized chat id without creating a reusable empty-source artifact');
  assertEqual(view.lastPreparedGeneration, null, 'empty normalized source does not create a reusable prepared artifact');
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
      throw Object.assign(
        new Error('snapshot failed with Bearer crash-token, sk-crash-runtime, and private-secret'),
        { code: 'RECURSION_SNAPSHOT_FAILED' }
      );
    }
  });
  let caughtError = null;
  try {
    await runtime.prepareForGeneration({ userMessage: 'Crash safely.' });
  } catch (error) {
    caughtError = error;
  }
  const view = runtime.view();
  assert(caughtError, 'runtime failure still throws to caller');
  assertNoSecretText(caughtError?.message || caughtError, 'runtime thrown error');
  assertEqual(view.activity.phase, 'settled', 'runtime failure settles activity');
  assertEqual(view.activity.severity, 'error', 'runtime failure is error severity');
  assertEqual(view.activity.logicalStage, 'started', 'runtime failure captures active logical stage');
  assertEqual(view.activity.detail.failure.code, 'RECURSION_SNAPSHOT_FAILED', 'runtime keeps diagnostic code');
  assertEqual(view.activity.detail.failure.category, 'internal', 'unknown runtime exception stays internal');
  assertEqual(view.activity.detail.failure.message, 'Recursion hit an unexpected internal error.', 'runtime exposes readable internal copy');
  assertEqual(view.activity.detail.message, undefined, 'runtime no longer emits legacy detail.message');
  assertNoSecretText(view.activity.detail, 'runtime failure activity detail');
}

{
  const firstInstallGate = deferred();
  let firstInstallStarted = false;
  let activeSource = 'first';
  const snapshotFor = (label) => ({
    chatId: `install-race-${label}`,
    chatKey: `install-race-${label}`,
    sceneKey: `install-race-${label}-scene`,
    sceneFingerprint: `install-race-${label}-scene-fp`,
    turnFingerprint: `install-race-${label}-turn-fp`,
    latestMesId: label === 'first' ? 1 : 2,
    messages: [{
      mesid: label === 'first' ? 1 : 2,
      role: 'user',
      text: `${label} install race source`,
      visible: true
    }]
  });
  let installCount = 0;
  const { runtime, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => snapshotFor(activeSource),
    hostPrompt: {
      async install() {
        installCount += 1;
        if (installCount === 1) {
          firstInstallStarted = true;
          await firstInstallGate.promise;
        }
        return { ok: true, installed: true };
      }
    }
  });
  const first = runtime.prepareForGeneration({ userMessage: 'first install race source' });
  await waitUntil(() => firstInstallStarted, 'first install race did not reach prompt installation');
  const supersedingSourceChange = runtime.handleSourceChanged({
    eventName: 'message_updated',
    messageId: 1
  });
  firstInstallGate.resolve();
  const firstResult = await first;
  await supersedingSourceChange;
  activeSource = 'second';
  const secondResult = await runtime.prepareForGeneration({ userMessage: 'second install race source' });
  assertEqual(firstResult.ok, false, 'source change during prompt installation does not complete stale work');
  assertEqual(firstResult.paused, true, `source change pauses the in-flight durable operation: ${JSON.stringify(firstResult)}`);
  assertEqual(secondResult.ok, true, 'newer run installs after stale prompt mutation settles');
  const committed = runtime.view().lastPreparedGeneration;
  assert(committed, 'newer install race run owns the committed artifact');
  assertEqual(committed.packet.packetId, secondResult.packet.packetId, 'stale install completion cannot replace newer artifact ownership');
  assert(!JSON.stringify(committed).includes('first install race source'), 'stale install source is absent from committed artifact');
  const staleJournal = await storage.loadRunJournal('install-race-first');
  assert(
    !staleJournal?.entries?.some((entry) => entry.event === 'prompt.installed' || entry.event === 'hand.selected'),
    'superseded install completion records no stale success journal'
  );
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
  assertEqual(second.ok, true, 'distinct same-chat turn runs after the active durable operation');
  const firstResult = await first;
  assertEqual(firstResult.ok, true, 'first durable operation completes before the distinct turn starts');
  assertNotEqual(firstResult.execution.operationId, second.execution.operationId, 'distinct turn callers receive distinct operation identities');
  assertEqual(utilityCalls, 3, 'first operation retries before the distinct turn runs its own Arbiter');
  assertEqual(firstAbortObserved, false, 'queued distinct turn does not abort the active provider attempt');
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
  assertEqual(result.ok, false, 'disposed run does not complete');
  assertEqual(result.paused, true, 'disposed run returns saved paused work');
  assertEqual(result.execution.pauseReason, 'runtime-disposed', 'disposed run records its pause reason');
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
  assertEqual(pendingResult.ok, false, 'chat change prevents in-flight generation preparation from completing');
  assertEqual(pendingResult.paused, true, 'chat change preserves in-flight generation preparation as paused work');
  assertEqual(pendingResult.execution.pauseReason, 'chat-changed', 'chat change records the durable pause reason');
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
  assertEqual(stopEntry.details.postProcessPending, false, 'stop journal captures pending Post-process state before cleanup');
  assertEqual(stopEntry.details.postProcessActive, false, 'stop journal captures active Post-process state before cleanup');
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
  const duplicateStop = runtime.stopGeneration({ source: 'recursion-progress-row' });
  const observedStop = runtime.handleHostGenerationStopped({
    eventName: 'generation_stopped',
    source: 'host-runtime'
  });
  releaseArbiter();
  const [stopResult, duplicateResult, observedResult, pendingResult] = await Promise.all([
    stopped,
    duplicateStop,
    observedStop,
    pending
  ]);
  assertEqual(pendingResult.ok, false, 'host generation stop prevents in-flight generation preparation from completing');
  assertEqual(pendingResult.paused, true, 'host generation stop preserves completed preprocessing work');
  assertEqual(pendingResult.execution.pauseReason, 'user-stop', 'host generation stop records the durable pause reason');
  assertEqual(stopResult.ok, true, 'unified stop cleanup succeeds');
  assertEqual(duplicateResult.ok, true, 'duplicate Stop shares the unified cancellation owner');
  assertEqual(observedResult.ok, true, 'host stop event observes the unified cleanup');
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
  assertEqual(pendingResult.ok, false, 'source change prevents in-flight generation preparation from completing');
  assertEqual(pendingResult.paused, true, 'source change preserves in-flight generation preparation as paused work');
  assertEqual(pendingResult.execution.pauseReason, 'source-changed', 'source change records the durable pause reason');
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
  assertEqual(result.ok, false, 'power toggle change prevents in-flight generation preparation from completing');
  assertEqual(result.paused, true, 'power toggle change preserves in-flight generation preparation as paused work');
  assertEqual(result.execution.pauseReason, 'settings-changed', 'power toggle records the durable pause reason');
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
  assertEqual(snapshotCalls, 2, 'newer run waits for in-flight prompt install before reading its turn snapshot');
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
  const routerCalls = [];
  const fallbackRouter = localFallbackCardRouter();
  const { runtime, settingsStore, storage } = createRuntimeHarness({
    generationRouter: {
      async generate(roleId, request, options) {
        routerCalls.push({ roleId, request, options });
        if (['providerTest', 'sceneFrameCard', 'fusedCardBundle'].includes(roleId)) {
          return profileCertificationResponse(roleId);
        }
        return fallbackRouter.generate(roleId, request, options);
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
  const prepared = await runtime.prepareForGeneration({ userMessage: 'Establish provider capability journal context.' });
  assertEqual(prepared.ok, true, 'provider capability journal test establishes a saved scene context');

  const utilityResult = await runtime.updateProviderConfig('utility', {
    connectionProfileId: 'utility-profile-v2',
    generationPolicy: {
      presetMode: 'isolated',
      instructMode: 'auto',
      samplerMode: 'recursion',
      structuredOutputMode: 'prompt-json'
    },
    samplerOverrides: { temperature: 0.2, topP: 0.8 },
    outputTokenCeiling: 4096
  });
  assertEqual(utilityResult.ok, true, 'runtime provider update returns success result');
  assertEqual(utilityResult.clear.ok, true, 'runtime provider update returns prompt clear result');
  const utility = utilityResult.provider;
  assertEqual(utility.connectionProfileId, 'utility-profile-v2', 'runtime provider update selects a Connection Profile');
  assertEqual(utility.generationPolicy.samplerMode, 'recursion', 'runtime provider update stores the sampler policy');
  assertEqual(utility.samplerOverrides.temperature, 0.2, 'runtime provider update stores the Utility temperature override');
  assertEqual(utility.outputTokenCeiling, 4096, 'runtime provider update stores the output ceiling');
  const viewProvider = runtime.view().settings.providers.utility;
  assertEqual(viewProvider.connectionProfileId, 'utility-profile-v2', 'runtime view exposes the selected profile for UI round-trip');
  assertEqual(viewProvider.generationPolicy.structuredOutputMode, 'prompt-json', 'runtime view exposes structured-output policy');
  assertEqual(viewProvider.samplerOverrides.topP, 0.8, 'runtime view exposes the sampler override');
  assertEqual(viewProvider.outputTokenCeiling, 4096, 'runtime view exposes the output ceiling');
  assertEqual(Object.hasOwn(viewProvider, 'endpoint'), false, 'runtime view omits transport endpoint state');
  assertNoSecretText(runtime.view().settings, 'runtime provider settings view');

  const providerTest = await runtime.testProvider('utility');
  assertEqual(providerTest.ok, true, 'runtime profile certification returns success');
  assertEqual(providerTest.certification.status, 'pass', 'runtime returns full profile certification');
  const certificationCalls = routerCalls.filter((entry) => ['providerTest', 'sceneFrameCard', 'fusedCardBundle'].includes(entry.roleId));
  assertDeepEqual(certificationCalls.map((entry) => entry.roleId), [
    'providerTest',
    'sceneFrameCard',
    'providerTest',
    'providerTest',
    'fusedCardBundle'
  ], 'runtime profile certification includes the bounded concurrency pair');
  assertDeepEqual(certificationCalls.map((entry) => entry.request.responseLength), [900, 900, 900, 900, 1792], 'certification uses thinking-safe bounded stage budgets');
  assert(certificationCalls.every((entry) => entry.request.lane === 'utility'), 'certification targets the selected lane');
  assert(certificationCalls.every((entry) => entry.request.reasoningCategory === 'provider-test'), 'certification labels diagnostic provider calls');
  assert(certificationCalls.every((entry) => entry.request.reasoningIntent === 'minimal'), 'certification always uses minimal provider reasoning');
  assert(certificationCalls.every((entry) => entry.options.timeoutMs === 30000), 'certification uses a bounded timeout');
  assertEqual(settingsStore.get().providers.utility.certification.status, 'pass', 'runtime persists passing profile certification');
  assertEqual(settingsStore.get().providers.utility.certification.checks.fusedCards, 'pass', 'runtime persists the Fused check');
  const capabilityJournal = await storage.loadRunJournal('chat-1');
  const capabilityEvents = capabilityJournal.entries.filter((entry) => entry.event === 'provider.capability.changed');
  assert(capabilityEvents.length >= 2, 'provider configuration and certification transitions are journaled');
  assertDeepEqual(
    capabilityEvents[0].details.changedKeys,
    [
      'connectionProfileId',
      'generationPolicy.samplerMode',
      'generationPolicy.structuredOutputMode',
      'samplerOverrides.temperature',
      'samplerOverrides.topP',
      'outputTokenCeiling'
    ],
    'provider capability journal records only field-scoped changed keys'
  );
  assertEqual(capabilityEvents[0].details.beforeState, 'fused-ready', 'provider capability journal records prior state');
  assertEqual(capabilityEvents[0].details.afterState, 'uncertified', 'provider capability journal records configuration transition');
  assertEqual(capabilityEvents.at(-1).details.afterState, 'fused-ready', 'provider capability journal records certification transition');
  const serializedCapabilityJournal = JSON.stringify(capabilityEvents);
  assert(!serializedCapabilityJournal.includes('utility-profile-v2'), 'provider capability journal omits the profile identifier');
  assertNoSecretText(capabilityEvents, 'provider capability journal');
}

{
  const routerCalls = [];
  const { runtime, settingsStore } = createRuntimeHarness({
    generationRouter: {
      async generate(roleId) {
        routerCalls.push(roleId);
        return profileCertificationResponse(roleId);
      }
    }
  });
  const result = await runtime.testProvider('utility', { scope: 'segmented' });
  assertEqual(result.ok, true, 'runtime Segmented-only profile certification succeeds');
  assertEqual(result.certification.status, 'partial', 'runtime Segmented-only certification is Segmented-ready');
  assertDeepEqual(routerCalls, ['providerTest', 'sceneFrameCard', 'providerTest', 'providerTest'], 'runtime Segmented-only certification checks concurrency without a Fused call');
  assertEqual(settingsStore.get().providers.utility.certification.checks.fusedCards, 'not-run', 'runtime persists an explicit untested Fused check');
}

{
  const providerGate = deferred();
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push({ roleId, request });
        if (roleId === 'providerTest') await providerGate.promise;
        return profileCertificationResponse(roleId);
      }
    }
  });
  const first = runtime.testProvider('utility');
  const second = runtime.testProvider('utility');
  await waitUntil(() => routerCalls.length === 1, 'single-flight profile certification did not start', { delayMs: 1 });
  assertEqual(first, second, 'duplicate same-lane profile certifications share one in-flight promise');
  assertDeepEqual(runtime.providerOperationState().tests, ['utility'], 'provider operation state exposes one active Utility certification');
  providerGate.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assertEqual(firstResult.ok, true, 'first single-flight profile certification succeeds');
  assertEqual(secondResult.ok, true, 'duplicate single-flight certification shares success');
  assertEqual(routerCalls.length, 5, 'duplicate same-lane certification runs one bounded sequence');
}


{
  const generationGate = deferred();
  let generationStarted = false;
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push({ roleId, request });
        assertEqual(roleId, 'utilityArbiter', 'busy provider-test fixture starts ordinary Utility generation');
        generationStarted = true;
        await generationGate.promise;
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'skip',
            cardJobs: [],
            reasonerDecision: { mode: 'skip', reason: 'provider-test busy fixture', signals: [] },
            budgets: { targetBriefTokens: 500, maxCards: 0 },
            diagnostics: ['provider-test-busy']
          }
        };
      }
    }
  });
  const generation = runtime.prepareForGeneration({ userMessage: 'Keep the active Utility run alive.' });
  await waitUntil(() => generationStarted, 'ordinary Utility generation did not enter the provider lane');
  const providerTest = await runtime.testProvider('utility');
  assertEqual(providerTest.ok, false, 'provider test refuses to overlap active same-lane generation');
  assertEqual(providerTest.error.code, 'RECURSION_PROVIDER_BUSY', 'provider test returns stable busy code');
  generationGate.resolve();
  const generationResult = await generation;
  assertEqual(generationResult.ok, true, 'active generation completes after busy provider test is rejected');
  assertEqual(generationResult.superseded, undefined, 'provider test does not supersede the active generation run');
  assertEqual(routerCalls.length, 1, 'busy provider test does not call the router');
}

{
  const providerGate = deferred();
  let providerTestStarted = false;
  const { runtime, settingsStore } = createRuntimeHarness({
    generationRouter: {
      async generate(roleId) {
        if (roleId === 'providerTest') {
          providerTestStarted = true;
          await providerGate.promise;
        }
        return profileCertificationResponse(roleId);
      }
    }
  });
  const test = runtime.testProvider('utility');
  await waitUntil(() => providerTestStarted, 'stale certification did not start', { delayMs: 1 });
  const before = settingsStore.get().providers.utility;
  const update = await runtime.updateProviderConfig('utility', {
    samplerOverrides: {
      temperature: before.samplerOverrides.temperature === 0.42 ? 0.43 : 0.42
    }
  });
  assertEqual(update.ok, true, 'provider configuration changes while an old certification is in flight');
  providerGate.resolve();
  const result = await test;
  const after = settingsStore.get().providers.utility;
  assertEqual(result.ok, true, 'stale certification preserves its staged result');
  assertEqual(result.certificationStale, true, 'configuration change marks the in-flight certification stale');
  assertEqual(after.certification.status, 'not-run', 'stale certification does not overwrite reset certification');
  assertEqual(after.configRevision, before.configRevision + 1, 'configuration change advances the provider revision');
}


for (const reasoningLevel of ['medium', 'high', 'ultra']) {
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: {
      mode: 'auto',
      reasoningLevel,
      reasonerUse: 'auto',
      providers: {
        reasoner: {
          connectionProfileId: ''
        }
      }
    },
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push({ roleId, request });
        assertEqual(roleId, 'utilityArbiter', `${reasoningLevel} unavailable Reasoner only calls the Utility Arbiter`);
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'skip',
            cardJobs: [],
            reasonerDecision: { mode: 'use', reason: 'Reasoner requested but unavailable.', signals: ['fallback'] },
            budgets: { targetBriefTokens: 500, maxCards: 0 },
            diagnostics: [`${reasoningLevel}-reasoner-fallback`]
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: `Use ${reasoningLevel} reasoning safely.` });
  assertEqual(result.ok, true, `${reasoningLevel} run completes when Reasoner is unavailable`);
  assert(routerCalls.length > 0, `${reasoningLevel} run reaches Utility`);
  assert(routerCalls.every((call) => call.request.lane === 'utility'), `${reasoningLevel} unavailable Reasoner routes ordinary work through Utility`);
  assert(!routerCalls.some((call) => call.roleId === 'reasonerComposer'), `${reasoningLevel} unavailable Reasoner does not call the Reasoner composer`);
}

{
  const proseHost = createProseMessageHarness('Mara hesitated at the dialing console.');
  const routerCalls = [];
  const { runtime, storage } = createRuntimeHarness({
    settings: {
      mode: 'auto',
      reasoningLevel: 'medium',
      reasonerUse: 'auto',
      enhancements: { mode: 'redirect', applyMode: 'as-swipe', contextMessages: 13 },
      providers: {
        reasoner: {
          connectionProfileId: ''
        }
      }
    },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push({ roleId, request });
        assertEqual(roleId, 'utilityArbiter', 'blocked Redirect preparation only calls the Utility Arbiter');
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: request.snapshotHash,
            action: 'skip',
            cardJobs: [],
            reasonerDecision: { mode: 'skip', reason: 'Redirect preflight fixture.', signals: [] },
            budgets: { targetBriefTokens: 500, maxCards: 0 },
            diagnostics: ['redirect-preflight']
          }
        };
      }
    }
  });
  const prepared = await runtime.prepareForGeneration({
    userMessage: 'Generate normally even though Redirect is not ready.',
    hostGeneration: true
  });
  assertEqual(prepared.ok, true, 'blocked Redirect does not block host prompt preparation');
  assertEqual(runtime.proseEnhancementPending(), true, 'blocked Redirect remains pending for deterministic settlement');
  assert(!JSON.stringify(runtime.view()).includes('RECURSION_REASONER_DISABLED'), 'blocked Redirect preflight never emits the retired disabled-lane error');

  const settled = await runtime.enhanceLatestAssistantMessage({ reason: 'assistant-message-landed' });
  assertEqual(settled.ok, true, 'blocked Redirect settles without a critical error');
  assertEqual(settled.skipped, true, 'blocked Redirect settles as skipped');
  assertEqual(settled.reason, 'provider-profile-missing', 'blocked Redirect reports the stable readiness reason');
  assertEqual(runtime.proseEnhancementPending(), false, 'blocked Redirect clears its pending marker after settlement');
  assertEqual(runtime.view().editorialResult.status, 'skipped', 'blocked Redirect exposes skipped Editorial status');
  assertEqual(runtime.view().editorialResult.outcome, 'provider-not-ready', 'blocked Redirect exposes provider readiness outcome');
  const preflightActivity = runtime.view().activityHistory.find((entry) => entry.phase === 'editorialPreflight');
  assert(preflightActivity, 'blocked Redirect marker is recorded when enhancement settles');
  assertEqual(preflightActivity.outcome, 'skipped', 'blocked Redirect marker records a readiness skip');
  assert(!routerCalls.some((call) => call.roleId.startsWith('editorial')), 'blocked Redirect makes no Editorial provider calls');
  const journal = await storage.loadRunJournal('prose-runtime-chat');
  assert(journal.entries.some((entry) => entry.event === 'editorial.preflight.skipped'), 'blocked Redirect journals the readiness skip');
  assert(!JSON.stringify({ settled, journal }).includes('RECURSION_REASONER_DISABLED'), 'blocked Redirect settlement never emits the retired disabled-lane error');
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
}

{
  const { runtime, settingsStore } = createRuntimeHarness({
    settings: { reasonerUse: 'always' },
    generationRouter: {
      async generate() {
        return {
          ok: false,
          error: {
            code: 'RECURSION_PROVIDER_AUTH_FAILED',
            message: 'Bearer sk-runtime-secret should not leak'
          }
        };
      }
    }
  });

  const failed = await runtime.testProvider('reasoner');
  assertEqual(failed.ok, false, 'runtime profile certification returns failure result');
  assertEqual(failed.error.code, 'RECURSION_PROVIDER_AUTH_FAILED', 'runtime profile certification returns a stable provider code');
  const reasoner = settingsStore.get().providers.reasoner;
  assertEqual(reasoner.certification.status, 'fail', 'runtime records failing profile certification');
  assertEqual(reasoner.certification.checks.connectivity, 'fail', 'runtime records failed connectivity');
  assertNoSecretText(reasoner.certification, 'profile certification failure');
  assertNoSecretText(failed, 'profile certification failure result');
}

{
  const { runtime, settingsStore } = createRuntimeHarness({
    generationRouter: {
      async generate() {
        return {
          ok: true,
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
  assertEqual(invalid.ok, false, 'runtime profile certification rejects invalid connectivity data');
  assertEqual(invalid.error.code, 'RECURSION_PROVIDER_TEST_INVALID', 'invalid connectivity returns a stable safe code');
  const utility = settingsStore.get().providers.utility;
  assertEqual(utility.certification.status, 'fail', 'invalid connectivity records failing certification');
  assertEqual(utility.certification.checks.connectivity, 'fail', 'invalid connectivity fails the first staged check');
  assertNoSecretText(utility.certification, 'invalid connectivity certification');
  assertNoSecretText(invalid, 'invalid connectivity result');
}

{
  const { runtime, settingsStore } = createRuntimeHarness({
    generationRouter: {
      async generate(roleId) {
        if (roleId === 'providerTest' || roleId === 'sceneFrameCard') {
          return profileCertificationResponse(roleId);
        }
        return {
          ok: true,
          data: {
            items: [{
              family: 'Scene Frame',
              promptText: 'Only one family was returned.',
              evidenceRefs: ['message:0']
            }]
          }
        };
      }
    }
  });

  const partial = await runtime.testProvider('utility');
  assertEqual(partial.ok, true, 'single-card success permits partial profile certification');
  assertEqual(partial.certification.status, 'partial', 'runtime exposes Segmented-only certification');
  const utility = settingsStore.get().providers.utility;
  assertEqual(utility.certification.status, 'partial', 'runtime persists partial certification');
  assertEqual(utility.certification.checks.singleCard, 'pass', 'partial certification permits Segmented stages');
  assertEqual(utility.certification.checks.fusedCards, 'fail', 'partial certification blocks Fused stages');
  assertEqual(runtime.view().settings.providers.utility.capability.state, 'segmented-ready', 'runtime view reports Segmented readiness');
  assertNoSecretText(partial, 'partial certification result');
}


console.log('[pass] runtime');
