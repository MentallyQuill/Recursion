import {
  classifyGeneration,
  createTurnIdentity,
  normalizeNativeGenerationType
} from '../../src/runtime/turn-scope.mjs';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

const messages = Array.from({ length: 14 }, (_, index) => ({
  mesid: index + 1,
  role: index % 2 === 0 ? 'user' : 'assistant',
  text: `message-${index + 1}`,
  swipe_id: index % 2 === 0 ? undefined : 0,
  visible: true
}));

const snapshot = {
  chatKey: 'chat-a',
  latestMesId: 14,
  messages,
  characterHash: 'character-a',
  groupHash: ''
};

const retention = {
  sourceWindowMessages: 12,
  sourceWindowCharacters: 12000
};

const contracts = {
  pipelineMode: 'segmented',
  attempts: 2,
  deckRevisionHash: 'deck-a',
  providerContractHash: 'provider-a',
  promptContractHash: 'prompt-a',
  schemaVersions: { pipelineRun: 2, checkpoint: 2, packet: 1 }
};

const first = await createTurnIdentity({
  snapshot,
  pendingUserMessage: { mesid: 13, text: 'message-13' },
  generationType: 'swipe',
  swipeMessageId: 14,
  retention,
  contracts
});

const outsideBandEdit = await createTurnIdentity({
  snapshot: {
    ...snapshot,
    messages: snapshot.messages.map((message) => (
      message.mesid === 1 ? { ...message, text: 'edited outside band' } : message
    ))
  },
  pendingUserMessage: { mesid: 13, text: 'message-13' },
  generationType: 'swipe',
  swipeMessageId: 14,
  retention,
  contracts
});

const insideBandEdit = await createTurnIdentity({
  snapshot: {
    ...snapshot,
    messages: snapshot.messages.map((message) => (
      message.mesid === 5 ? { ...message, text: 'edited inside band' } : message
    ))
  },
  pendingUserMessage: { mesid: 13, text: 'message-13' },
  generationType: 'swipe',
  swipeMessageId: 14,
  retention,
  contracts
});

assertEqual(
  first.turnKeyHash,
  outsideBandEdit.turnKeyHash,
  'outside-band edit preserves turn identity'
);
assert(
  first.turnKeyHash !== insideBandEdit.turnKeyHash,
  'inside-band edit changes turn identity'
);
assertEqual(first.sourceBandLimit, 12, 'turn identity records configured band limit');
assertEqual(first.sourceBandMessageCount, 12, 'turn identity records actual band count');
assertEqual(first.sourceWindowFirstMesId, '2', 'bounded swipe source records first message id');
assertEqual(first.sourceWindowLastMesId, '13', 'swiped assistant is excluded from Pre-process source');

const repeatedTextNewId = await createTurnIdentity({
  snapshot: { ...snapshot, latestMesId: 15 },
  pendingUserMessage: { mesid: 15, text: 'message-13' },
  generationType: 'normal',
  retention,
  contracts
});
assert(
  first.turnKeyHash !== repeatedTextNewId.turnKeyHash,
  'same text with a new message id is a new turn'
);

assertEqual(normalizeNativeGenerationType('SWIPE'), 'swipe');
assertEqual(normalizeNativeGenerationType('regenerate'), 'regenerate');
assertEqual(normalizeNativeGenerationType('unknown'), 'normal');

assertEqual(classifyGeneration({
  nativeGenerationType: 'swipe',
  pendingUserMessage: null,
  currentTurnKeyHash: first.turnKeyHash,
  storedTurnKeyHash: first.turnKeyHash,
  storedOperationState: 'completed'
}).kind, 'same-turn-swipe');

assertEqual(classifyGeneration({
  nativeGenerationType: 'swipe',
  pendingUserMessage: null,
  currentTurnKeyHash: first.turnKeyHash,
  storedTurnKeyHash: first.turnKeyHash,
  storedOperationState: 'paused'
}).kind, 'compatible-paused-same-turn');

assertEqual(classifyGeneration({
  nativeGenerationType: 'swipe',
  pendingUserMessage: null,
  currentTurnKeyHash: insideBandEdit.turnKeyHash,
  storedTurnKeyHash: first.turnKeyHash,
  storedOperationState: 'paused'
}).kind, 'incompatible-paused-operation');

assertEqual(classifyGeneration({
  nativeGenerationType: 'swipe',
  pendingUserMessage: null,
  currentTurnKeyHash: insideBandEdit.turnKeyHash,
  storedTurnKeyHash: first.turnKeyHash,
  storedOperationState: 'completed'
}).kind, 'edited-band-swipe');

assertEqual(classifyGeneration({
  nativeGenerationType: 'normal',
  pendingUserMessage: { mesid: 15, text: 'message-13' },
  currentTurnKeyHash: repeatedTextNewId.turnKeyHash,
  storedTurnKeyHash: first.turnKeyHash,
  storedOperationState: 'completed'
}).kind, 'new-user-turn');

assertEqual(classifyGeneration({
  nativeGenerationType: 'regenerate',
  pendingUserMessage: null,
  currentTurnKeyHash: repeatedTextNewId.turnKeyHash,
  storedTurnKeyHash: '',
  storedOperationState: ''
}).kind, 'new-host-generation');

console.log('Turn scope tests passed.');
