import { createRecursionRuntime } from '../../src/runtime.mjs';
import { createSettingsStore } from '../../src/settings.mjs';
import { createDefaultCardDeck } from '../../src/pre-process-decks.mjs';
import { createMemoryStorageAdapter, createStorageRepository } from '../../src/storage.mjs';

export async function runCardBudgetFixture({ pipelineMode = 'segmented', reasoningLevel = 'medium',
  minCards = 8, maxCards = 12, strength = 'balanced', authoredCount = 3,
  allowedFamilies = null, partial = false, failedFamily = '', priorityFamily = '',
  proposed = ['Knowledge'], storage = null } = {}) {
  const deck = createDefaultCardDeck();
  deck.id = 'budget-fixture'; deck.readonly = false; deck.bundled = false;
  for (const card of Object.values(deck.cards)) {
    card.selectionState = allowedFamilies && !allowedFamilies.includes(card.builtinFamily)
      ? 'off' : card.builtinFamily === priorityFamily ? 'priority' : 'active';
  }
  const categoryId = deck.categoryOrder[0];
  for (let index = 0; index < authoredCount; index++) {
    const id = `authored-${index}`;
    deck.cards[id] = { id, categoryId, name: `Authored ${index + 1}`, kind: 'authored',
      promptText: `Preserve player agency and visible continuity (${index + 1}).`, selectionState: 'priority' };
    deck.cardOrderByCategory[categoryId].push(id);
  }
  const settingsStore = createSettingsStore({ root: {} });
  settingsStore.update({ pipelineMode, reasoningLevel, minCards, maxCards, strength, reasonerUse: 'off',
    modelAttemptsPerStep: 2, providers: { utility: { connectionProfileId: 'fixture' } },
    preProcessDecks: { activeDeckId: deck.id, customDecks: { [deck.id]: deck } } });
  const calls = [];
  let installed = null;
  const repository = storage || createStorageRepository({ storage: createMemoryStorageAdapter() });
  const runtime = createRecursionRuntime({ settingsStore, storage: repository,
    host: {
      providerProfiles: { list: () => [{ id: 'fixture', name: 'Fixture', completionMode: 'chat' }] },
      snapshot: async () => ({ chatId: 'budget', chatKey: 'budget', sceneKey: 'budget-scene',
        sourceRevisionHash: 'budget-source', latestMesId: 2, messages: [
          { mesid: 1, role: 'assistant', text: 'Mara waits beside the sealed archive.', visible: true },
          { mesid: 2, role: 'user', text: 'I ask what she remembers.', visible: true }
        ] }),
      prompt: { install: async packet => { installed = packet; return { ok: true, installed: true }; },
        clear: async () => ({ ok: true }) }, messages: {}, generation: {}
    },
    generationRouter: { async generate(roleId, request) {
      calls.push({ roleId, request });
      if (roleId === 'utilityArbiter') return { ok: true, data: {
        schema: 'recursion.utilityArbiter.v1', snapshotHash: request.snapshotHash,
        action: 'refresh-cards', sceneStatus: 'same-scene', promptFootprint: 'normal',
        cardJobs: proposed.map(family => ({ family, reason: 'Ground the next question in visible evidence.' })),
        budgets: { targetBriefTokens: 500, maxCards: 1 },
        reasonerDecision: { mode: 'skip', reason: 'Fixture', signals: [] }, diagnostics: []
      } };
      if (roleId === 'guidanceComposer') return { ok: true, data: {
        schema: 'recursion.guidanceComposer.v1', snapshotHash: request.snapshotHash,
        guidanceText: 'Keep Mara at the archive and answer the immediate question.',
        sourceCardIds: [], guardrailCardIds: [], omittedCardIds: [], diagnostics: []
      } };
      const item = family => ({ family, promptText: `Keep the current ${family.toLowerCase()} grounded in the archive exchange.`, evidenceRefs: ['message:2'] });
      if (roleId === 'fusedCardBundle') return { ok: true, data: { items:
        (partial ? request.requestedCards.slice(0, 1) : request.requestedCards)
          .filter(card => card.family !== failedFamily).map(card => item(card.family)) } };
      if (request.metadata?.family === failedFamily) return { ok: false, error: {
        code: 'RECURSION_PROVIDER_SCHEMA_MISMATCH', message: 'Fixture invalid card.', retryable: false
      } };
      return { ok: true, data: item(request.metadata.family) };
    } }
  });
  const result = await runtime.prepareForGeneration({ userMessage: { text: 'I ask what she remembers.', mesid: 2 } });
  return { result, runtime, view: runtime.view(), calls, installed, storage: repository };
}
