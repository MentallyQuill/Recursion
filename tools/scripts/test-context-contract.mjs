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
  postProcess: { contextMessages: 35 }
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

const completeText = `${'A long exchange. '.repeat(220)}The door was unlocked and they left.`;
const intact = boundEnhancementMessages([{ text: 'Older scene.' }, { text: completeText }], 3, 4000);
assertEqual(intact.messages.at(-1).text, completeText, 'selected context retains complete messages and their endings');
const overBudget = boundEnhancementMessages([{ text: 'Older scene.' }, { text: completeText }], 3, 2000);
assertEqual(overBudget.messages.length, 0, 'a message that does not fit is omitted whole, never clipped');

console.log('[pass] context-contract');
