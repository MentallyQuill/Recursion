import { createRecursionRuntime } from '../../src/runtime.mjs';
import { createSettingsStore } from '../../src/settings.mjs';
import { createMemoryStorageAdapter, createStorageRepository } from '../../src/storage.mjs';
import { packetToPromptBlocks } from '../../src/prompt.mjs';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

const UTILITY_ARBITER_SCHEMA = 'recursion.utilityArbiter.v1';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createRuntimeHarness({ settings = {}, generationRouter }) {
  const installedPackets = [];
  const installedBlocks = [];
  const settingsStore = createSettingsStore({ root: {} });
  settingsStore.update(settings);
  const storage = createStorageRepository({ storage: createMemoryStorageAdapter() });
  const host = {
    async snapshot() {
      return clone({
        chatId: 'sg-1-chat',
        chatKey: 'sg-1-chat',
        sceneKey: 'sg-1-scene',
        sceneFingerprint: 'sg-1-scene-fp',
        turnFingerprint: 'sg-1-turn-fp',
        latestMesId: 2,
        messages: [
          { mesid: 1, role: 'assistant', text: 'SG-1 faces Will inside the simulated parking lot.', visible: true },
          { mesid: 2, role: 'user', text: 'ONeill asks for proof before accepting anything.', visible: true }
        ]
      });
    },
    prompt: {
      async install(packet) {
        installedPackets.push(packet);
        installedBlocks.push(...packetToPromptBlocks(packet));
        return { ok: true, installed: true };
      },
      async clear() {
        return { ok: true, cleared: true };
      }
    }
  };
  const runtime = createRecursionRuntime({ host, settingsStore, storage, generationRouter });
  return { runtime, installedPackets, installedBlocks, storage };
}

const generatedCardTextByRole = {
  sceneFrameCard: 'SG1_SCENE_FRAME_CARD: ONeill holds the parking-lot line and must choose proof or withdrawal.',
  activeCastCard: 'SG1_ACTIVE_CAST_CARD: Carter verifies the construct while Daniel and Tealc hold position.',
  characterMotivationCard: 'SG1_MOTIVATION_CARD: ONeill needs leverage before accepting Will offer.',
  dialogueRelationshipCard: 'SG1_RELATIONSHIP_CARD: Will presses recruitment while SG-1 distrust stays visible.',
  knowledgeSecretsCard: 'SG1_KNOWLEDGE_CARD: Simulation boundary, idle gate, no DHD, and Tuesday loop stay true.',
  openThreadsCard: 'SG1_OPEN_THREADS_CARD: Immediate unresolved thread is proof demand versus gate withdrawal.'
};

const tokenEstimateByRole = {
  sceneFrameCard: 130,
  activeCastCard: 260,
  characterMotivationCard: 135,
  dialogueRelationshipCard: 210,
  knowledgeSecretsCard: 210,
  openThreadsCard: 130
};

const familyByRole = {
  sceneFrameCard: 'Scene Frame',
  activeCastCard: 'Active Cast',
  characterMotivationCard: 'Character Motivation',
  dialogueRelationshipCard: 'Relationship',
  knowledgeSecretsCard: 'Knowledge',
  openThreadsCard: 'Open Threads'
};

const guidancePrompts = [];
const { runtime, installedBlocks, storage } = createRuntimeHarness({
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
            reasonerDecision: { mode: 'skip', reason: 'all generated cards must inject', signals: [] },
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
          family: familyByRole[roleId],
          snapshotHash: request.snapshotHash,
          items: [{
            promptText: text,
            evidenceRefs: ['message:2'],
            tokenEstimate: tokenEstimateByRole[roleId]
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
const cache = await storage.loadSceneCache(view.lastSnapshot.chatKey, view.lastSnapshot.sceneKey);

assertEqual(result.ok, true, 'all generated card run installs prompt');
assertEqual(cache.cards.length, 6, 'scene cache persists every generated card');
assertEqual(view.lastHand.cards.length, 6, 'legacy target brief budget does not drop generated active cards');
assertEqual(view.lastPacket.selectedCardRefs.length, 6, 'prompt packet refs include every generated active card');
const guidancePrompt = guidancePrompts[0] || '';
const injectedCardEvidence = installedBlocks.find((block) => block.id === 'cardEvidence')?.text || '';
for (const marker of Object.values(generatedCardTextByRole)) {
  assert(guidancePrompt.includes(marker), `guidance composer receives ${marker}`);
  assert(view.lastPacket.sections.cardEvidence.includes(marker), `packet card evidence includes ${marker}`);
  assert(injectedCardEvidence.includes(marker), `installed prompt includes ${marker}`);
}

console.log('[pass] runtime card packet');
