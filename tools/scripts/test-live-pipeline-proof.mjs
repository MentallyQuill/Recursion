import { readFileSync } from 'node:fs';
import { assertDeepEqual, assertEqual, assertRejects } from '../../tests/helpers/assert.mjs';
import { createDefaultCardDeck } from '../../src/pre-process-decks.mjs';
import {
  LIFECYCLE_PROOF_SECTIONS,
  validateLifecycleProof
} from './lib/lifecycle-proof-contract.mjs';

const module = await import('./prove-live-pipelines.mjs');
const scriptText = readFileSync(new URL('./prove-live-pipelines.mjs', import.meta.url), 'utf8');

assertEqual(typeof module.selectPipeline, 'function', 'selectPipeline is exported for focused harness tests');
assertEqual(typeof module.selectInjectionSettings, 'function', 'selectInjectionSettings is exported for focused harness tests');
assertEqual(typeof module.configureSoakDeckFixture, 'function', 'soak deck fixture is exported for focused harness tests');
assertEqual(typeof module.inspectMilestoneVerdict, 'function', 'milestone verdict helper is exported for focused harness tests');
assertEqual(typeof module.sanitizeLiveProofReport, 'function', 'live proof report sanitizer is exported for focused harness tests');
assertEqual(typeof module.inspectCertificationPreflight, 'function', 'selected-profile certification verdict is exported for focused harness tests');
for (const helper of [
  'waitForRoot',
  'setPower',
  'selectMode',
  'ensureRunnableDeckFixture',
  'sendAndWait',
  'exportDiagnosticsSnapshot',
  'liveSnapshotScript',
  'contextChatSummaryScript',
  'selectUtilityProfileByLabel',
  'certifyUtilityProfile',
  'resolveExactUtilityProfile'
]) {
  assertEqual(typeof module[helper], 'function', `${helper} is exported for the resilience coordinator`);
}

const previousSillyTavern = globalThis.SillyTavern;
globalThis.SillyTavern = {
  getContext: () => ({
    chat: [{ is_user: true }, { is_user: false }],
    getCurrentChatId: () => 'getter-only-live-chat'
  })
};
assertDeepEqual(module.contextChatSummaryScript()(), {
  length: 2,
  assistantCount: 1,
  userCount: 1,
  lastIsUser: false,
  chatId: 'getter-only-live-chat'
}, 'live summary uses SillyTavern current-chat getter when direct fields are absent');
globalThis.SillyTavern = previousSillyTavern;

let alreadySelectedPipelineClicks = 0;
await module.selectPipeline({
  evaluate: async () => 'segmented',
  locator: () => ({
    first: () => ({ click: async () => { alreadySelectedPipelineClicks += 1; } })
  })
}, 'segmented', 1000);
assertEqual(alreadySelectedPipelineClicks, 0, 'pipeline selector is a no-op when the requested pipeline is already active');

assertDeepEqual(module.resolveExactUtilityProfile([
  { name: 'nanogpt DeepSeek Flash - Provider', model: 'deepseek-flash' },
  { name: 'nanogpt DeepSeek Flash 0731 - Celia', model: 'deepseek-flash-0731' }
], 'nanogpt DeepSeek Flash - Provider'), {
  ok: true,
  index: 0,
  label: 'nanogpt DeepSeek Flash - Provider',
  model: 'deepseek-flash'
}, 'Utility profile resolution requires one exact safe-label match');
assertDeepEqual(module.resolveExactUtilityProfile([
  { name: 'nanogpt DeepSeek Flash - Provider', model: 'deepseek-flash' }
], 'DeepSeek Flash'), {
  ok: false,
  reason: 'profile-not-found',
  requestedLabel: 'DeepSeek Flash'
}, 'Utility profile resolution rejects partial matching');
assertDeepEqual(module.resolveExactUtilityProfile([
  { name: 'same-label', model: 'one' },
  { name: 'same-label', model: 'two' }
], 'same-label'), {
  ok: false,
  reason: 'profile-label-ambiguous',
  requestedLabel: 'same-label'
}, 'Utility profile resolution rejects ambiguous exact labels');
assertDeepEqual(
  module.inspectCertificationPreflight({
    utility: { ok: true, status: 'partial', checks: { connectivity: 'pass', singleCard: 'pass', fusedCards: 'fail' } },
    reasoner: { ok: true, status: 'pass', checks: { connectivity: 'pass', singleCard: 'pass', fusedCards: 'pass' } }
  }),
  { ok: true, effectiveFusedLane: 'reasoner', errors: [] },
  'High-reasoning preflight accepts Segmented-ready Utility plus Fused-ready Reasoner'
);
assertEqual(
  module.inspectCertificationPreflight({
    utility: { ok: true, status: 'partial', checks: { connectivity: 'pass', singleCard: 'pass', fusedCards: 'fail' } },
    reasoner: { ok: false, status: 'fail', checks: { connectivity: 'fail', singleCard: 'not-run', fusedCards: 'not-run' } }
  }).ok,
  false,
  'certification preflight rejects a configuration without a Fused-ready effective lane'
);

const completedBaseStages = [
  'preprocess.snapshot',
  'preprocess.arbiter',
  'preprocess.deck',
  'preprocess.hand',
  'preprocess.guidance',
  'preprocess.packet',
  'preprocess.install'
].map((stageId) => ({ stageId, stageState: 'completed', attemptCount: 1 }));
const diagnosticsFor = ({ pipeline, cardStages, mode = 'auto', families = ['Scene Frame', 'Open Threads'], planDiagnostics = [] }) => ({
  settings: { mode, minCards: 2, maxCards: 2 },
  runtime: {
    execution: {
      operationId: 'operation-current',
      operationState: 'completed',
      diagnosticCodes: [],
      stages: [...completedBaseStages, ...cardStages]
    },
    hand: { selectedCount: 2, families },
    packet: { diagnostics: { pipelineMode: pipeline, planDiagnostics } }
  }
});

assertEqual(
  module.inspectMilestoneVerdict({
    pipeline: 'segmented',
    mode: 'manual',
    requestedFamilies: ['Scene Frame', 'Open Threads'],
    diagnostics: diagnosticsFor({
      pipeline: 'segmented',
      mode: 'manual',
      cardStages: [
        { stageId: 'preprocess.cards.segmented.scene-frame', stageState: 'completed', attemptCount: 1 },
        { stageId: 'preprocess.cards.segmented.open-threads', stageState: 'completed', attemptCount: 1 }
      ]
    })
  }).ok,
  true,
  'Manual Segmented verdict requires exactly the two requested completed card stages'
);
assertEqual(
  module.inspectMilestoneVerdict({
    pipeline: 'fused',
    mode: 'auto',
    diagnostics: diagnosticsFor({
      pipeline: 'fused',
      cardStages: [{ stageId: 'preprocess.cards.fused', stageState: 'completed', attemptCount: 1 }]
    })
  }).ok,
  true,
  'Fused verdict accepts one genuine completed fused bundle stage'
);
for (const [label, diagnostics] of [
  ['segmented fallback', diagnosticsFor({
    pipeline: 'fused',
    cardStages: [
      { stageId: 'preprocess.cards.fused', stageState: 'completed', attemptCount: 1 },
      { stageId: 'preprocess.cards.segmented.open-threads', stageState: 'completed', attemptCount: 1 }
    ],
    planDiagnostics: ['fused-fallback-segmented']
  })],
  ['stranded stage', diagnosticsFor({
    pipeline: 'fused',
    cardStages: [{ stageId: 'preprocess.cards.fused', stageState: 'running', attemptCount: 1 }]
  })],
  ['duplicate fused stage', diagnosticsFor({
    pipeline: 'fused',
    cardStages: [
      { stageId: 'preprocess.cards.fused', stageState: 'completed', attemptCount: 1 },
      { stageId: 'preprocess.cards.fused', stageState: 'completed', attemptCount: 1 }
    ]
  })]
]) {
  assertEqual(
    module.inspectMilestoneVerdict({ pipeline: 'fused', mode: 'auto', diagnostics }).ok,
    false,
    `Fused verdict rejects ${label}`
  );
}

const sanitizedReport = module.sanitizeLiveProofReport({
  status: 'fail',
  connectionProfileId: 'PROFILE_SECRET',
  request: { prompt: 'RAW_PROMPT_SECRET' },
  response: { content: 'RAW_RESPONSE_SECRET' },
  messageProof: { message: 'TRANSCRIPT_SECRET', userIndex: 2, assistantAfter: true },
  details: { operationId: 'operation-safe', providerLabel: 'bounded-label' }
});
assertEqual(JSON.stringify(sanitizedReport).includes('SECRET'), false, 'live proof sanitizer removes profiles and raw request/response content');
assertEqual(sanitizedReport.details.operationId, 'operation-safe', 'live proof sanitizer preserves bounded execution identity');
assertDeepEqual(
  sanitizedReport.messageProof,
  { message: '[redacted]', userIndex: 2, assistantAfter: true },
  'live proof sanitizer removes transcript text while preserving message-boundary evidence'
);

const deckFixture = {
  version: 1,
  activeDeckId: 'soak-deck',
  customDecks: {
    'soak-deck': {
      id: 'soak-deck',
      cards: {
        scene: { builtinFamily: 'Scene Frame', selectionState: 'active' },
        threads: { builtinFamily: 'Open Threads', selectionState: 'off' },
        cast: { builtinFamily: 'Active Cast', selectionState: 'active' }
      }
    }
  }
};
const manualDeckFixture = module.configureSoakDeckFixture(deckFixture, {
  mode: 'manual',
  families: ['Scene Frame', 'Open Threads']
});
assertDeepEqual(
  Object.values(manualDeckFixture.customDecks['soak-deck'].cards).map((card) => [card.builtinFamily, card.selectionState]),
  [
    ['Scene Frame', 'active'],
    ['Open Threads', 'active'],
    ['Active Cast', 'off']
  ],
  'Manual soak fixture activates exactly the requested families and disables every other family'
);
const bundledDeck = createDefaultCardDeck({ now: '2026-08-08T00:00:00.000Z' });
const manualBundledFixture = module.configureSoakDeckFixture({
  version: 1,
  activeDeckId: 'default',
  customDecks: {},
  defaultCardStates: {}
}, {
  mode: 'manual',
  families: ['Scene Frame', 'Open Threads']
});
assertDeepEqual(
  [...new Set(Object.entries(bundledDeck.cards)
    .filter(([cardId]) => manualBundledFixture.defaultCardStates[cardId] !== 'off')
    .map(([, card]) => card.builtinFamily))],
  ['Scene Frame', 'Open Threads'],
  'Manual soak fixture constrains the bundled default deck to exactly the requested families'
);
assertDeepEqual(
  module.configureSoakDeckFixture(deckFixture, { mode: 'auto', families: [] }),
  deckFixture,
  'Auto soak fixture preserves an already-runnable deck selection'
);
assertDeepEqual(
  module.inspectPacketInjectionMetadata({
    injectedBlocks: [
      { promptKey: 'recursion.guidance', placement: 'in_chat', depth: 4, role: 'system' },
      { promptKey: 'recursion.cardEvidence', placement: 'in_chat', depth: 4, role: 'system' },
      { promptKey: 'recursion.guardrails', placement: 'in_chat', depth: 4, role: 'system' }
    ]
  }, { placement: 'in_chat', depth: 4, role: 'system' }),
  {
    source: 'validated-packet',
    placement: 'in_chat',
    expectedPosition: 1,
    expectedDepth: 4,
    expectedRole: 0,
    blocks: [
      { key: 'recursion.guidance', present: true, placement: 'in_chat', position: 1, depth: 4, role: 0, valid: true },
      { key: 'recursion.cardEvidence', present: true, placement: 'in_chat', position: 1, depth: 4, role: 0, valid: true },
      { key: 'recursion.guardrails', present: true, placement: 'in_chat', position: 1, depth: 4, role: 0, valid: true }
    ],
    complete: true
  },
  'packet injection evidence preserves selected placement, numeric position, depth, and System role'
);
assertDeepEqual(
  module.parseArgs([
    '--live',
    '--pipelines', 'segmented,fused',
    '--placements', 'in_prompt,in_chat',
    '--depth', '4'
  ]),
  {
    live: true,
    pipelines: ['segmented', 'fused'],
    placements: ['in_prompt', 'in_chat'],
    depth: 4,
    role: 'system',
    mode: 'auto',
    families: [],
    certifyOnly: false
  },
  'live pipeline proof parses the complete placement matrix and configured depth'
);
assertDeepEqual(
  module.parseArgs(['--mode', 'manual', '--families', 'Scene Frame,Open Threads']),
  {
    live: false,
    pipelines: ['segmented', 'fused'],
    placements: ['in_prompt', 'in_chat'],
    depth: 4,
    role: 'system',
    mode: 'manual',
    families: ['Scene Frame', 'Open Threads'],
    certifyOnly: false
  },
  'live pipeline proof parses an exact two-family Manual contract'
);
assertEqual(
  module.parseArgs(['--certify-only']).certifyOnly,
  true,
  'live pipeline proof supports a no-generation selected-profile certification preflight'
);
await assertRejects(
  async () => module.parseArgs(['--mode', 'manual', '--families', 'Scene Frame']),
  /exactly two/,
  'Manual live proof rejects an underspecified card scope'
);
await assertRejects(
  async () => module.parseArgs(['--placement', 'somewhere_else']),
  /Unknown placement/,
  'live pipeline proof rejects unsupported injection placements'
);
assertDeepEqual(
  module.inspectStoredRecursionPrompts({
    'recursion.guidance': { value: 'Guidance:\nUse evidence.', position: 0, depth: 4, role: 0 },
    'recursion.cardEvidence': { value: 'Card evidence:\n- Keep facts.', position: 0, depth: 4, role: 0 },
    'recursion.guardrails': { value: 'Guardrails:\n- Honor facts.', position: 0, depth: 4, role: 0 }
  }, { placement: 'in_prompt', depth: 4, role: 'system' }),
  {
    placement: 'in_prompt',
    expectedPosition: 0,
    expectedDepth: 4,
    expectedRole: 0,
    blocks: [
      { key: 'recursion.guidance', present: true, position: 0, depth: 4, role: 0, valid: true },
      { key: 'recursion.cardEvidence', present: true, position: 0, depth: 4, role: 0, valid: true },
      { key: 'recursion.guardrails', present: true, position: 0, depth: 4, role: 0, valid: true }
    ],
    complete: true
  },
  'In Prompt evidence requires all Recursion blocks at position zero with configured System role and depth'
);
assertEqual(
  module.inspectStoredRecursionPrompts({
    'recursion.guidance': { value: 'Guidance.', position: 0, depth: 1, role: 0 }
  }, { placement: 'in_chat', depth: 4, role: 'system' }).complete,
  false,
  'In Chat evidence rejects In Prompt position and incorrect depth'
);
assertEqual(scriptText.includes('warmRapid'), false, 'live pipeline proof does not depend on removed background warming');

const validLifecycleProof = {
  newTurn: { arbiterCalls: 1, turnKeyChanged: true },
  unchangedSwipe: { recursionModelCalls: 0, packetReinstalled: true },
  editedBandSwipe: { reuseRejected: true, queuedIntentCanceled: true },
  reprocessSwipe: { selectedStageCalls: 1, intentConsumed: true },
  fullFreshSwipe: { arbiterCalls: 1, requestedCardCalls: 1 },
  stop: { hostStopCalls: 1, promptClears: 1, state: 'paused' },
  resume: { hostStartCalls: 1, detachedProviderCalls: 0 },
  postProcess: { responseIdentityChanged: true, priorRewriteReused: false }
};
assertDeepEqual(
  LIFECYCLE_PROOF_SECTIONS,
  ['newTurn', 'unchangedSwipe', 'editedBandSwipe', 'reprocessSwipe', 'fullFreshSwipe', 'stop', 'resume', 'postProcess'],
  'lifecycle proof exposes every required section in report order'
);
assertEqual(validateLifecycleProof(validLifecycleProof).ok, true, 'complete lifecycle proof validates');
assertEqual(
  validateLifecycleProof({ ...validLifecycleProof, resume: { hostStartCalls: 1, detachedProviderCalls: 1 } }).ok,
  false,
  'lifecycle proof rejects detached Resume provider work'
);
assertEqual(
  validateLifecycleProof({ ...validLifecycleProof, editedBandSwipe: undefined }).errors.includes('editedBandSwipe:missing'),
  true,
  'lifecycle proof rejects a missing edited-band section'
);

{
  const calls = [];
  const pipelineButton = {
    async click() {
      calls.push('pipeline-click');
    }
  };
  const segmentedChoice = {
    async click() {
      calls.push('segmented-choice-click');
    }
  };
  let evaluateCount = 0;
  const page = {
    async evaluate(fn) {
      evaluateCount += 1;
      if (evaluateCount === 1) {
        calls.push('evaluate-current-pipeline');
        return '';
      }
      calls.push('evaluate-close-viewer');
      const fakeDocument = {
        querySelector(selector) {
          if (selector === '[data-recursion-viewer]') {
            return {
              open: true,
              hidden: false,
              close() {
                calls.push('viewer-close');
              }
            };
          }
          return null;
        }
      };
      const originalDocument = globalThis.document;
      globalThis.document = fakeDocument;
      try {
        return fn();
      } finally {
        if (originalDocument === undefined) {
          delete globalThis.document;
        } else {
          globalThis.document = originalDocument;
        }
      }
    },
    locator(selector) {
      if (selector === '[data-recursion-pipeline-button]') return { first: () => pipelineButton };
      if (selector.includes('data-recursion-pipeline-choice="segmented"')) return { first: () => segmentedChoice };
      throw new Error(`Unexpected locator: ${selector}`);
    },
    async waitForFunction() {
      calls.push('wait-for-function');
    }
  };

  await module.selectPipeline(page, 'segmented', 1000);

  assertEqual(calls[0], 'evaluate-current-pipeline', 'selectPipeline checks current state before opening the menu');
  assertEqual(calls[1], 'evaluate-close-viewer', 'selectPipeline closes an open viewer before clicking Pipeline');
  assertEqual(calls[2], 'viewer-close', 'open viewer close method is invoked before Pipeline click');
  assertEqual(calls[3], 'pipeline-click', 'Pipeline click happens after viewer cleanup');
}

console.log('[pass] live pipeline proof');
