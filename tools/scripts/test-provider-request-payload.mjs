import assert from 'node:assert/strict';
import { requestMessages } from '../../src/providers/request-payload.mjs';

assert.deepEqual(requestMessages({ systemPrompt: 'Evidence.', prompt: 'Task.', messages: [] }), [
  { role: 'system', content: 'Evidence.' }, { role: 'user', content: 'Task.' }
], 'empty messages use the complete prompt path');
assert.deepEqual(requestMessages({ prompt: 'Ignored.', messages: [{ role: 'unknown', text: 'Actual.', metadata: 'ignored' }] }), [
  { role: 'user', content: 'Actual.' }
], 'signatures and host dispatch share message normalization');
console.log('Provider request payload tests passed.');
