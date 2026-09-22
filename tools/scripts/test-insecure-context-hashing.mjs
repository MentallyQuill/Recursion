import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { stableHash } from '../../src/execution/provenance.mjs';
import { createTurnIdentity } from '../../src/runtime/turn-scope.mjs';

const fixture = {
  snapshot: { chatKey: 'lan-chat', messages: [{ mesid: 0, role: 'user', text: 'Hello 🌍' }] },
  pendingUserMessage: { mesid: 0, text: 'Hello 🌍' },
  generationType: 'normal', contracts: { version: 1 }
};
const secureIdentity = await createTurnIdentity(fixture);
const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
try {
  for (const unavailable of [{}, undefined]) {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: unavailable });
    for (const value of ['', 'abc', '🌍 café 漢字', ...[53, 54, 55, 56, 63, 64, 65, 10000].map(n => 'x'.repeat(n))]) {
      assert.equal(await stableHash(value), createHash('sha256').update(JSON.stringify(value)).digest('hex'));
    }
    assert.equal(await stableHash({ b: 2, a: 1 }), createHash('sha256').update('{"a":1,"b":2}').digest('hex'));
    assert.deepEqual(await createTurnIdentity(fixture), secureIdentity, 'HTTP and HTTPS must produce identical turn identities');
    await assert.rejects(stableHash({ invalid: undefined }), /JSON-safe/);
  }
} finally {
  Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
}
console.log('[pass] insecure-context SHA-256 and turn identity');
