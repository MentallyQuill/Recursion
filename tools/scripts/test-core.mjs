import {
  asArray,
  assertObject,
  cloneJson,
  compact,
  fnv1a,
  hashJson,
  makeId,
  nowIso,
  parseJsonObject,
  redact,
  safeId,
  stableStringify,
  truncate
} from '../../src/core.mjs';
import { assert, assertEqual, assertDeepEqual, assertRejects } from '../../tests/helpers/assert.mjs';

function captureError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected function to throw');
}

assertDeepEqual(cloneJson({ a: 1 }), { a: 1 }, 'cloneJson clones plain objects');
assertEqual(compact('  a\n b\t c  '), 'a b c', 'compact normalizes whitespace');
assertEqual(truncate('abcdef', 4), 'a...', 'truncate caps strings');
assertEqual(truncate('abcdef', 4.9), 'a...', 'truncate normalizes fractional limits');
assertEqual(safeId('Chat: One / Two'), 'Chat-One-Two', 'safeId removes unsafe characters');
assertEqual(safeId('***', '../unsafe path'), 'unsafe-path', 'safeId sanitizes fallback values');
assertEqual(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}', 'stableStringify sorts keys');
const shared = { value: 1 };
assertEqual(
  stableStringify({ b: shared, a: shared }),
  '{"a":{"value":1},"b":{"value":1}}',
  'stableStringify preserves repeated references'
);
const cyclicJson = { name: 'loop' };
cyclicJson.self = cyclicJson;
assertEqual(
  stableStringify(cyclicJson),
  '{"name":"loop","self":"[Circular]"}',
  'stableStringify marks only true cycles'
);
assertEqual(fnv1a('recursion'), fnv1a('recursion'), 'hash is stable');
assert(fnv1a('\u{1F600}') !== fnv1a('\u{1F601}'), 'hash distinguishes astral unicode code points');
assertEqual(hashJson({ a: 1 }), hashJson({ a: 1 }), 'json hash is stable');
assertDeepEqual(parseJsonObject('```json\n{"ok":true}\n```'), { ok: true }, 'parser accepts fenced json');
const parseError = captureError(() => parseJsonObject('not-json'));
assertEqual(parseError.code, 'RECURSION_JSON_PARSE_FAILED', 'parser exposes parse failure code');
const arrayError = captureError(() => parseJsonObject('[]'));
assertEqual(arrayError.code, 'RECURSION_JSON_OBJECT_REQUIRED', 'parser rejects arrays with object-required code');

const redacted = redact({
  apiKey: 'secret',
  nested: { authorization: 'bearer token', keep: 'visible' },
  list: [{ password: 'secret2' }],
  privateKey: 'private',
  credentials: 'creds',
  authHeader: 'auth',
  tokenCount: 4
});
assertEqual(redacted.apiKey, '[redacted]', 'apiKey redacted');
assertEqual(redacted.nested.authorization, '[redacted]', 'authorization redacted');
assertEqual(redacted.nested.keep, 'visible', 'safe value preserved');
assertEqual(redacted.list[0].password, '[redacted]', 'nested array secret redacted');
assertEqual(redacted.privateKey, '[redacted]', 'privateKey redacted');
assertEqual(redacted.credentials, '[redacted]', 'credentials redacted');
assertEqual(redacted.authHeader, '[redacted]', 'authHeader redacted');
assertEqual(redacted.tokenCount, 4, 'tokenCount is preserved');

const cyclicSecret = { keep: 'visible', apiKey: 'secret' };
cyclicSecret.self = cyclicSecret;
const redactedCycle = redact(cyclicSecret);
assertEqual(redactedCycle.keep, 'visible', 'cycle-safe redaction preserves safe values');
assertEqual(redactedCycle.apiKey, '[redacted]', 'cycle-safe redaction redacts secret values');
assertEqual(redactedCycle.self, '[Circular]', 'redaction marks true cycles');

assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(nowIso()), 'nowIso returns ISO timestamp');
assert(makeId('Unsafe Prefix').startsWith('Unsafe-Prefix-'), 'makeId includes sanitized prefix');
const objectValue = { ok: true };
assertEqual(assertObject(objectValue, 'payload'), objectValue, 'assertObject returns valid objects');
assertEqual(captureError(() => assertObject(undefined)).message, 'value must be an object', 'assertObject has default label');
const listValue = [1];
assertEqual(asArray(listValue), listValue, 'asArray returns arrays unchanged');
assertDeepEqual(asArray('not-array'), [], 'asArray returns empty array for non-arrays');

await assertRejects(async () => parseJsonObject('not-json'), /valid JSON object/, 'invalid json rejects');
console.log('[pass] core utilities');
