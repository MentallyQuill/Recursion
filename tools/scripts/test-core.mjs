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
  tokenCount: 4,
  rawPrompt: 'raw prompt body',
  rawResponse: 'raw response body',
  providerPrompt: 'provider prompt body',
  providerResponse: 'provider response body',
  hiddenReasoning: 'hidden reasoning body',
  reasoning: 'provider-native reasoning body',
  reasoning_details: [{ text: 'provider-native reasoning details' }],
  reasoningIntent: 'high',
  privateStoryPlan: 'private story plan',
  privatePlan: 'private plan',
  privatePlanPayload: 'future branch plan payload must not persist',
  sessionId: 'session-id-value',
  sessionIdPayload: 'session-live-payload-12345',
  providerPrivatePlanPayload: 'future branch plan payload must not persist',
  currentSessionIdPayload: 'session-live-payload-12345',
  rawPromptText: 'raw prompt text body',
  rawPromptBody: 'raw prompt body suffix body',
  rawPromptData: 'raw prompt data suffix body',
  rawPromptValue: 'raw prompt value suffix body',
  debugRawPrompt: 'debug raw prompt body',
  providerResponseText: 'provider response text body',
  providerResponseBody: 'provider response body suffix body',
  providerResponseData: 'provider response data suffix body',
  providerResponseValue: 'provider response value suffix body',
  rawPromptHashRawPromptText: 'raw prompt repeated forbidden suffix body',
  sessionIdentifierSessionIdPayload: 'session repeated forbidden payload body',
  providerResponseHash: 'provider-response-hash-safe',
  providerResponseMs: 54,
  rawPromptHash: 'raw-prompt-hash-safe',
  privatePlanningEnabled: true,
  sessionIdentifier: 'session-identifier-safe',
  sessionCount: 2
});
const serializedRedacted = JSON.stringify(redacted);
assertEqual(redacted.apiKey, '[redacted]', 'apiKey redacted');
assertEqual(redacted.nested.authorization, '[redacted]', 'authorization redacted');
assertEqual(redacted.nested.keep, 'visible', 'safe value preserved');
assertEqual(redacted.list[0].password, '[redacted]', 'nested array secret redacted');
assertEqual(redacted.privateKey, '[redacted]', 'privateKey redacted');
assertEqual(redacted.credentials, '[redacted]', 'credentials redacted');
assertEqual(redacted.authHeader, '[redacted]', 'authHeader redacted');
assertEqual(redacted.tokenCount, 4, 'tokenCount is preserved');
assertEqual(redacted.rawPrompt, '[redacted]', 'rawPrompt redacted');
assertEqual(redacted.rawResponse, '[redacted]', 'rawResponse redacted');
assertEqual(redacted.providerPrompt, '[redacted]', 'providerPrompt redacted');
assertEqual(redacted.providerResponse, '[redacted]', 'providerResponse redacted');
assertEqual(redacted.hiddenReasoning, '[redacted]', 'hiddenReasoning redacted');
assertEqual(redacted.reasoning, '[redacted]', 'provider-native reasoning key redacted');
assertEqual(redacted.reasoning_details, '[redacted]', 'provider-native reasoning details key redacted');
assertEqual(redacted.reasoningIntent, 'high', 'safe reasoning intent metadata is preserved');
assertEqual(redacted.privateStoryPlan, '[redacted]', 'privateStoryPlan redacted');
assertEqual(redacted.privatePlan, '[redacted]', 'privatePlan redacted');
assertEqual(redacted.privatePlanPayload, '[redacted]', 'privatePlan payload key redacted');
assertEqual(redacted.sessionId, '[redacted]', 'sessionId redacted');
assertEqual(redacted.sessionIdPayload, '[redacted]', 'sessionId payload key redacted');
assertEqual(redacted.providerPrivatePlanPayload, '[redacted]', 'nested-form privatePlan payload key redacted');
assertEqual(redacted.currentSessionIdPayload, '[redacted]', 'nested-form sessionId payload key redacted');
assertEqual(redacted.rawPromptText, '[redacted]', 'rawPrompt text key redacted');
assertEqual(redacted.rawPromptBody, '[redacted]', 'rawPrompt body key redacted');
assertEqual(redacted.rawPromptData, '[redacted]', 'rawPrompt data key redacted');
assertEqual(redacted.rawPromptValue, '[redacted]', 'rawPrompt value key redacted');
assertEqual(redacted.debugRawPrompt, '[redacted]', 'debug rawPrompt key redacted');
assertEqual(redacted.providerResponseText, '[redacted]', 'providerResponse text key redacted');
assertEqual(redacted.providerResponseBody, '[redacted]', 'providerResponse body key redacted');
assertEqual(redacted.providerResponseData, '[redacted]', 'providerResponse data key redacted');
assertEqual(redacted.providerResponseValue, '[redacted]', 'providerResponse value key redacted');
assertEqual(redacted.rawPromptHashRawPromptText, '[redacted]', 'later rawPrompt text occurrence redacted');
assertEqual(redacted.sessionIdentifierSessionIdPayload, '[redacted]', 'later sessionId payload occurrence redacted');
assertEqual(redacted.providerResponseHash, 'provider-response-hash-safe', 'provider response hash is preserved');
assertEqual(redacted.providerResponseMs, 54, 'provider response timing metric is preserved');
assertEqual(redacted.rawPromptHash, 'raw-prompt-hash-safe', 'raw prompt hash is preserved');
assertEqual(redacted.privatePlanningEnabled, true, 'private planning setting flag is preserved');
assertEqual(redacted.sessionIdentifier, 'session-identifier-safe', 'session identifier label is preserved');
assertEqual(redacted.sessionCount, 2, 'sessionCount is preserved');
assert(!serializedRedacted.includes('future branch plan payload must not persist'), 'privatePlan payload string omitted');
assert(!serializedRedacted.includes('session-live-payload-12345'), 'sessionId payload string omitted');

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
