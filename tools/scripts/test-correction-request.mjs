import { buildStructuredCorrectionRequest } from '../../src/execution/correction-request.mjs';
import { assertEqual, assert } from '../../tests/helpers/assert.mjs';

const original = { roleId: 'sceneFrameCard', request: {
  prompt: 'Ground this card in the snapshot.',
  messages: [{ role: 'system', content: 'Use the supplied evidence.' }, { role: 'user', content: 'Original source.' }],
  responseLength: 900
} };
const corrected = buildStructuredCorrectionRequest({ originalRequest: original, failure: { code: 'RECURSION_JSON_PARSE_FAILED' }, taskFeedback: 'Return one grounded Scene Frame card.' });
assertEqual(corrected.request.messages.length, 3, 'correction reaches the message array used by the host');
assert(corrected.request.messages[2].content.includes('Return one grounded Scene Frame card.'), 'role feedback reaches the dispatched request');
assertEqual(original.request.messages.length, 2, 'correction does not mutate the original request');
const second = buildStructuredCorrectionRequest({ originalRequest: original,
  currentRequest: { ...corrected, request: { ...corrected.request, responseLength: 1800 } },
  failure: { code: 'RECURSION_PROVIDER_SCHEMA_MISMATCH', fieldIssues: [{ path: '$.promptText', rule: 'type', message: 'MODEL_TEXT_CANARY' }] }
});
assertEqual(second.request.messages.length, 3, 'successive corrections replace feedback instead of stacking');
assertEqual(second.request.responseLength, 1800, 'correction retains the current capacity budget');
assert(second.request.messages[2].content.includes('$.promptText'), 'correction identifies the invalid field');
assert(!second.request.messages[2].content.includes('MODEL_TEXT_CANARY'), 'correction never repeats arbitrary issue text');
const emptyMessages = buildStructuredCorrectionRequest({ originalRequest: { prompt: 'Original source.', messages: [] } });
assertEqual(emptyMessages.messages.length, 0, 'an empty message list preserves the source prompt dispatch path');
assert(emptyMessages.prompt.includes('Original source.'), 'empty message corrections retain source evidence');
console.log('Correction request tests passed.');
