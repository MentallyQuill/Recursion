import { buildContextContract, boundEnhancementMessages } from '../../src/context-contract.mjs';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

const snapshot = {
  messages: Array.from({ length: 18 }, (_, index) => ({ mesid: index + 1, text: `message-${index + 1}` })),
  sourceWindowFirstMesId: 1,
  sourceWindowLastMesId: 18,
  sourceWindowTruncated: true,
  sourceWindowLimitReason: 'message-cap'
};
const contract = buildContextContract(snapshot, {
  retention: {
    sourceWindowMessages: 20,
    sourceWindowCharacters: 12000,
    providerVisibleMessages: 12
  },
  enhancements: { contextMessages: 35 }
});
assertEqual(contract.sourceWindow.actualMessages, 18, 'context contract records bounded source count');
assertEqual(contract.providerContext.effectiveMessages, 12, 'context contract caps provider messages');
assertEqual(contract.enhancementContext.effectiveMessages, 18, 'context contract caps enhancement messages to source window');

const bounded = boundEnhancementMessages(
  [{ text: 'a'.repeat(1000) }, { text: 'b'.repeat(1000) }, { text: 'c'.repeat(1000) }],
  3,
  2100
);
assertEqual(bounded.messages.length, 2, 'enhancement context enforces total character budget');
assert(bounded.characters <= 2100, 'enhancement context stays within character budget');

console.log('[pass] context-contract');
