import { assert, assertEqual, assertDeepEqual, assertRejects } from '../../tests/helpers/assert.mjs';

assert(true, 'assert accepts true');
assertEqual(2 + 2, 4, 'math works');
assertDeepEqual({ a: 1 }, { a: 1 }, 'deep equality works');
assertDeepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }, 'deep equality ignores property order');
await assertRejects(async () => {
  throw new Error('expected failure');
}, /expected failure/);
await assertRejects(() => assert(false), /Assertion failed/);
await assertRejects(() => assertEqual(1, 2), /Values are not equal/);
await assertRejects(() => assertDeepEqual({ a: 1 }, { a: 2 }), /Objects are not equal/);
await assertRejects(async () => assertRejects(async () => {}, /x/), /Expected rejection/);
await assertRejects(async () => {
  throw new Error('string failure');
}, 'string failure');

console.log('[pass] harness assertions');
