import {
  assert,
  assertDeepEqual,
  assertEqual
} from '../../tests/helpers/assert.mjs';
import {
  PROVIDER_RESPONSE_ERROR_CODES,
  assertProviderResponseText,
  collectProviderResponseFinishReasons,
  describeProviderResponse,
  extractProviderContentText,
  extractProviderResponseReasoning,
  extractProviderResponseText,
  getProviderResponseFailure,
  isProviderResponseTokenLimitFinishReason
} from '../../src/providers/provider-response-normalizer.mjs';
import {
  STRUCTURED_OUTPUT_PARSE_ERROR_CODES,
  parseStructuredJsonText,
  repairCommonJson,
  stripReasoningBlocks
} from '../../src/providers/structured-output-parser.mjs';

const strict = parseStructuredJsonText('{"schema":"recursion.providerTest.v1","ok":true}');
assertEqual(strict.ok, true, 'strict object parses');
assertEqual(strict.repaired, false, 'strict object is not marked repaired');
assertEqual(strict.value.schema, 'recursion.providerTest.v1', 'strict object value returned');

const fenced = parseStructuredJsonText('```json\n{"schema":"recursion.providerTest.v1","ok":true}\n```');
assertEqual(fenced.ok, true, 'fenced json parses');
assertEqual(fenced.value.ok, true, 'fenced json value returned');

const wrapped = parseStructuredJsonText('Here is the JSON:\n{"schema":"recursion.providerTest.v1","ok":true}\nDone.');
assertEqual(wrapped.ok, true, 'wrapper prose with first balanced object parses');

const reasoningWrapped = parseStructuredJsonText('<think>drafting private content</think>\n{"schema":"recursion.providerTest.v1","ok":true}');
assertEqual(reasoningWrapped.ok, true, 'think wrapper is stripped before parsing');
assertEqual(stripReasoningBlocks('<reasoning>hidden</reasoning>{"ok":true}'), '{"ok":true}', 'reasoning wrapper strip keeps visible json');

const commented = parseStructuredJsonText(`{
  // provider comment
  "schema": "recursion.providerTest.v1",
  "ok": true,
  "message": "Line one
Line two",
}`);
assertEqual(commented.ok, true, 'comments trailing commas and literal line breaks are repaired');
assertEqual(commented.repaired, true, 'commented json is marked repaired');
assertEqual(commented.value.message, 'Line one\nLine two', 'literal line break inside string is preserved as newline');

const smartQuoted = parseStructuredJsonText('\uFEFF{\u201cschema\u201d:\u201crecursion.providerTest.v1\u201d,\u201cok\u201d:true}');
assertEqual(smartQuoted.ok, true, 'BOM and smart quotes are repaired');
assertEqual(smartQuoted.value.schema, 'recursion.providerTest.v1', 'smart quote repair preserves schema');

const missingSchema = parseStructuredJsonText('{"ok":true,}');
assertEqual(missingSchema.ok, true, 'repair does not reject syntactically repairable object');
assertEqual(Object.prototype.hasOwnProperty.call(missingSchema.value, 'schema'), false, 'repair does not fabricate missing schema');

const arrayResult = parseStructuredJsonText('[]');
assertEqual(arrayResult.ok, false, 'array rejects when object required');
assertEqual(arrayResult.diagnostic.code, STRUCTURED_OUTPUT_PARSE_ERROR_CODES.JSON_NOT_OBJECT, 'array rejection has not-object code');

const invalid = parseStructuredJsonText('no object here');
assertEqual(invalid.ok, false, 'no-object text rejects');
assertEqual(invalid.diagnostic.code, STRUCTURED_OUTPUT_PARSE_ERROR_CODES.JSON_INVALID, 'no-object text has invalid json code');

assertEqual(repairCommonJson('{"a":1,}'), '{"a":1}', 'common repair removes trailing object comma');

assertEqual(extractProviderResponseText({
  choices: [{ message: { content: '{"schema":"recursion.providerTest.v1","ok":true}' }, finish_reason: 'stop' }]
}), '{"schema":"recursion.providerTest.v1","ok":true}', 'OpenAI message content extracted');

assertEqual(extractProviderResponseText({
  choices: [{ delta: { content: '{"schema":"recursion.providerTest.v1"}' }, finishReason: 'stop' }]
}), '{"schema":"recursion.providerTest.v1"}', 'delta content extracted');

assertEqual(extractProviderContentText([
  { type: 'text', text: 'alpha' },
  { content: [{ text: ' beta' }, { value: ' gamma' }] }
]), 'alpha beta gamma', 'nested provider content arrays extracted');

assertEqual(extractProviderResponseText({
  candidates: [{ content: [{ text: 'candidate text' }] }]
}), 'candidate text', 'candidate content extracted');

assertEqual(extractProviderResponseText({
  outputs: [{ content: [{ value: 'output text' }] }]
}), 'output text', 'output content extracted');

assertEqual(extractProviderResponseText({ response: '{"ok":true}' }), '{"ok":true}', 'direct response text extracted');
assertEqual(extractProviderResponseText({ schema: 'recursion.providerTest.v1', ok: true }), '{"schema":"recursion.providerTest.v1","ok":true}', 'object-shaped structured response is serialized');

const reasoningOnly = {
  choices: [{
    message: {
      content: '',
      reasoning_details: [{ text: 'hidden chain of thought' }]
    },
    finish_reason: 'stop'
  }]
};
assertEqual(extractProviderResponseText(reasoningOnly), '', 'reasoning-only visible text is empty');
assertEqual(extractProviderResponseReasoning(reasoningOnly), 'hidden chain of thought', 'reasoning details extracted separately');
assertEqual(getProviderResponseFailure(reasoningOnly, { providerTitle: 'Utility' }).code, PROVIDER_RESPONSE_ERROR_CODES.REASONING_ONLY, 'reasoning-only failure classified');

const tokenLimited = {
  choices: [{ message: { content: '{"schema":"partial"' }, stopReason: 'max_completion_tokens' }]
};
assertDeepEqual(collectProviderResponseFinishReasons(tokenLimited), ['max_completion_tokens'], 'finish reason collected from message stopReason');
assertEqual(isProviderResponseTokenLimitFinishReason('token_limit_reached'), true, 'token-limit variants classified');
const tokenFailure = getProviderResponseFailure(tokenLimited, { providerTitle: 'Utility', maxTokens: 512 });
assertEqual(tokenFailure.code, PROVIDER_RESPONSE_ERROR_CODES.TOKEN_LIMIT, 'token-limit failure classified before parsing');
assertEqual(tokenFailure.reasoningLength, 0, 'token-limit diagnostic includes reasoning length');

const emptyFailure = getProviderResponseFailure({ choices: [{ message: { content: '   ' } }] }, { providerTitle: 'Utility' });
assertEqual(emptyFailure.code, PROVIDER_RESPONSE_ERROR_CODES.EMPTY_CONTENT, 'empty visible output classified');

const described = describeProviderResponse(reasoningOnly);
assertEqual(described.visibleContentLength, 0, 'provider description includes visible length');
assertEqual(described.reasoningLength, 'hidden chain of thought'.length, 'provider description includes reasoning length');

assertEqual(assertProviderResponseText({ text: 'visible' }, { providerTitle: 'Utility' }), 'visible', 'assertProviderResponseText returns visible text');
assertProviderResponseText({ schema: 'recursion.providerTest.v1', ok: true }, { providerTitle: 'Utility' });

// Schema-specific JSON repairs must be added only after a recurring Recursion provider failure proves the need.
// Directive has an operation-array closer repair for its own state-delta schema; Recursion does not port it by default.

console.log('[pass] provider response parser');
