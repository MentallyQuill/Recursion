import {
  assert,
  assertDeepEqual,
  assertEqual
} from '../../tests/helpers/assert.mjs';
import { createGenerationRouter } from '../../src/providers.mjs';

const siblingRouter = createGenerationRouter({ client: { generate: async () => ({
  text: JSON.stringify({ items: [
    { family: 'Scene Frame', promptText: 'Track the objective.', evidenceRefs: ['message:0'] },
    { family: 'Active Cast', promptText: [], evidenceRefs: ['message:0'] }
  ] })
}) } });
const siblings = await siblingRouter.generate('fusedCardBundle', {});
assertEqual(siblings.ok, true, 'valid Fused envelope survives malformed sibling');
assertEqual(siblings.data.items.length, 1, 'only valid sibling reaches grounding validation');
import {
  PROVIDER_RESPONSE_ERROR_CODES,
  assertProviderResponseText,
  collectProviderResponseFinishReasons,
  describeProviderResponse,
  extractProviderContentText,
  extractProviderResponseReasoning,
  extractProviderResponseText,
  getProviderResponseFailure,
  isProviderResponseTokenLimitFinishReason,
  normalizeProviderEnvelope
} from '../../src/providers/provider-response-normalizer.mjs';
import {
  extractJsonObjectsFromArrayProperty,
  STRUCTURED_OUTPUT_PARSE_ERROR_CODES,
  parseStructuredJsonText,
  repairCommonJson,
  stripReasoningBlocks
} from '../../src/providers/structured-output-parser.mjs';

const envelopeFixtures = [
  { name: 'chat content', input: { choices: [{ message: { content: '{"ok":true}' } }] }, expectedText: '{"ok":true}' },
  { name: 'text completion', input: { choices: [{ text: '{"ok":true}' }] }, expectedText: '{"ok":true}' },
  { name: 'direct structured object', input: { schema: 'recursion.providerTest.v1', ok: true }, expectedStructured: { schema: 'recursion.providerTest.v1', ok: true } },
  { name: 'direct parsed object', input: { parsed: { ok: true } }, expectedStructured: { ok: true } },
  { name: 'message parsed object', input: { choices: [{ message: { parsed: { ok: true } } }] }, expectedStructured: { ok: true } },
  { name: 'tool arguments', input: { choices: [{ message: { tool_calls: [{ function: { arguments: '{"ok":true}' } }] } }] }, expectedStructured: { ok: true } },
  { name: 'legacy function arguments', input: { choices: [{ message: { function_call: { arguments: '{"ok":true}' } } }] }, expectedStructured: { ok: true } },
  {
    name: 'Claude tool input',
    input: {
      content: [{
        type: 'tool_use',
        name: 'recursion_provider_test',
        input: { schema: 'recursion.providerTest.v1', ok: true }
      }]
    },
    expectedStructured: { schema: 'recursion.providerTest.v1', ok: true }
  }
];
assertEqual(getProviderResponseFailure({ choices: [{ message: { refusal: 'Declined' } }] }).code,
  PROVIDER_RESPONSE_ERROR_CODES.REFUSAL, 'explicit refusal is distinct from malformed output');
assertEqual(getProviderResponseFailure({ choices: [{ finish_reason: 'content_filter', message: { content: 'partial' } }] }).code,
  PROVIDER_RESPONSE_ERROR_CODES.CONTENT_FILTER, 'filtered partial content is never accepted');
assertEqual(getProviderResponseFailure({ text: 'A character refused the invitation.' }), null,
  'narrative refusal words do not classify a provider refusal');
for (const fixture of envelopeFixtures) {
  const envelope = normalizeProviderEnvelope(fixture.input);
  if (fixture.expectedText !== undefined) assertEqual(envelope.text, fixture.expectedText, `${fixture.name} text`);
  if (fixture.expectedStructured !== undefined) assertDeepEqual(envelope.structured, fixture.expectedStructured, `${fixture.name} structured`);
}
assertDeepEqual(parseStructuredJsonText('[{"ok":true}]').value, { ok: true }, 'singleton object array unwraps');
assertDeepEqual(parseStructuredJsonText('[1,2]\nTrailing object: {"ok":true}').value, { ok: true }, 'non-object first candidate does not stop later object recovery');
assertEqual(JSON.stringify(parseStructuredJsonText('not json')).includes('sample'), false, 'diagnostics contain no output sample');

const strict = parseStructuredJsonText('{"schema":"recursion.providerTest.v1","ok":true}');
const quotedPunctuationValue = { promptText: 'He said “{” loudly.', evidenceRefs: ['message:1'] };
const quotedPunctuation = parseStructuredJsonText(JSON.stringify(quotedPunctuationValue));
assertEqual(quotedPunctuation.ok, true, 'curly quotes inside a valid JSON string do not expose its braces');
assertDeepEqual(quotedPunctuation.value, quotedPunctuationValue, 'strict JSON string punctuation is unchanged');
assertEqual(quotedPunctuation.repaired, false, 'valid JSON with curly punctuation needs no repair');
assertDeepEqual(extractJsonObjectsFromArrayProperty(`{"items":[${JSON.stringify(quotedPunctuationValue)},{"family":`),
  [quotedPunctuationValue], 'complete salvaged member preserves curly punctuation and quoted braces');
assertDeepEqual(parseStructuredJsonText('{“promptText”:“Keep the doorway visible.”}').value,
  { promptText: 'Keep the doorway visible.' }, 'typographic delimiter repair remains supported');
const duplicateKey = parseStructuredJsonText('{"promptText":"first","promptText":"second"}');
assertEqual(duplicateKey.ok, false, 'same-object duplicate keys require correction');
assertEqual(duplicateKey.diagnostic.code, 'json_ambiguous', 'duplicate-key failure is ambiguity');
const competingRoots = parseStructuredJsonText('Example: {"example":true}\nAnswer: {"promptText":"answer"}');
assertEqual(competingRoots.ok, false, 'competing root objects require correction');
assertEqual(competingRoots.diagnostic.code, 'json_ambiguous', 'competing roots are ambiguous');
assertEqual(parseStructuredJsonText('{"promptText":"first","prompt\\u0054ext":"second"}').diagnostic.code,
  'json_ambiguous', 'escaped equivalent names are duplicate keys');
assertEqual(parseStructuredJsonText('{"left":{"name":"one"},"right":{"name":"two"}}').ok,
  true, 'same key in distinct objects is legal');
assertEqual(parseStructuredJsonText('{"promptText":"Quoted { braces } and \\\"items\\\": [{ text } ]"}').ok,
  true, 'quoted JSON-like content never becomes a root');
assertEqual(parseStructuredJsonText('[{"ok":true}]').repairKind, 'singleton-array-normalization',
  'singleton array unwrapping is recorded as normalization');
const oversized = parseStructuredJsonText('{"text":"' + 'a'.repeat(262144) + '"}');
assertEqual(oversized.ok, false, 'oversized structured text fails without a partial object');
assertEqual(oversized.diagnostic.code,
  'json_size_limit', 'oversized structured text is bounded');
const tooDeep = parseStructuredJsonText('{"nested":'.repeat(65) + 'true' + '}'.repeat(65));
assertEqual(tooDeep.ok, false, 'depth overflow rejects the whole object');
assertEqual(tooDeep.diagnostic.code, 'json_depth_limit', 'depth overflow diagnostic is specific');
const unfinishedObject = parseStructuredJsonText('{"items":[{"promptText":"complete"}');
assertEqual(unfinishedObject.ok, false, 'JSON repair never fabricates a closing bundle boundary');
assertDeepEqual(extractJsonObjectsFromArrayProperty('{"note":"fake \\\"items\\\": [{\\\"family\\\":\\\"Fake\\\"}]", "items":[{"family":"Real"}]}'),
  [{ family: 'Real' }], 'fragment scanning uses an actual array property outside strings');
assertDeepEqual(extractJsonObjectsFromArrayProperty('{"debug":{"items":[{"family":"Nested"}]},"items":[[{"family":"Array child"}],{"family":"Real"}]}'),
  [{ family: 'Real' }], 'only direct root-property object members are recovered');
const excessiveBundleText = JSON.stringify({ items: Array.from({ length: 41 }, (_, i) => ({ family: `family-${i}` })) });
const excessiveBundle = parseStructuredJsonText(excessiveBundleText);
assertEqual(excessiveBundle.ok, false, 'more than forty bundle members fails the output bound');
assertEqual(excessiveBundle.diagnostic.code, 'json_item_limit', 'bundle bound diagnostic is specific');
assertDeepEqual(extractJsonObjectsFromArrayProperty(excessiveBundleText), [], 'overflow does not become a partial trusted bundle');
const ambiguousProvider = await createGenerationRouter({ client: { generate: async () => ({ text: '{"items":[],"items":[]}' }) } }).generate('fusedCardBundle', {});
assertEqual(ambiguousProvider.error.code, 'RECURSION_JSON_AMBIGUOUS', 'router exposes a fixed ambiguity code for correction');
const longPartialText = '{"items":[' + JSON.stringify({ family: 'Scene Frame', promptText: 'a'.repeat(13000), evidenceRefs: ['message:8'] })
  + ',' + JSON.stringify({ family: 'Active Cast', promptText: 'Keep the cast visible.', evidenceRefs: ['message:8'] }) + ',{"family":';
const longPartialProvider = await createGenerationRouter({ client: { generate: async () => ({ text: longPartialText }) } }).generate('fusedCardBundle', {
  requestedCards: [{ family: 'Scene Frame' }, { family: 'Active Cast' }]
});
assertEqual(longPartialProvider.ok, false, 'broken bundle envelope remains an output failure');
assert(Array.isArray(longPartialProvider.recoverableItems), 'provider failures return transient complete members');
assertDeepEqual(longPartialProvider.recoverableItems.map((item) => item.family), ['Scene Frame', 'Active Cast'],
  'complete later members survive beyond old diagnostic truncation');
const badToolEnvelope = normalizeProviderEnvelope({ choices: [{ message: { tool_calls: [{ function: { arguments: '{"promptText":"first","promptText":"second"}' } }] } }] });
assertEqual(badToolEnvelope.structured, null, 'tool arguments cannot bypass duplicate-key checks');
assertEqual(badToolEnvelope.text, '{"promptText":"first","promptText":"second"}', 'unsafe tool JSON remains visible parser input for a fixed diagnostic');
const incompleteCard = parseStructuredJsonText('MODEL_PRIVATE_TEXT is not JSON');
assertEqual(incompleteCard.ok, false, 'unparseable prose fails structured output');
assertEqual(JSON.stringify(incompleteCard).includes('MODEL_PRIVATE_TEXT'), false, 'parse diagnostics never echo rejected model values');
assertDeepEqual(extractJsonObjectsFromArrayProperty('{"items":[garbage {"family":"Not a member"},{"family":"Real"}]}'),
  [{ family: 'Real' }], 'a brace inside a malformed scalar is not an actual array-member start');
const nonObjectOverflow = parseStructuredJsonText(JSON.stringify({ items: Array(41).fill(null) }));
assertEqual(nonObjectOverflow.ok, false, 'invalid scalar members still count toward a complete bundle bound');
assertEqual(nonObjectOverflow.diagnostic.code, 'json_item_limit');
assertDeepEqual(extractJsonObjectsFromArrayProperty('{"items":[' + Array(40).fill('null').join(',') + ',{"family":"Real"}]}'), [],
  'fragment recovery cannot ignore scalar members to bypass the bundle bound');
assertDeepEqual(parseStructuredJsonText('Explanation: "quoted { } text"\nAnswer: {"ok":true}').value, { ok: true },
  'balanced recovery ignores a quoted empty object in wrapper prose');
assertDeepEqual(parseStructuredJsonText('// comment with { }\nActual answer: {"ok":true}').value, { ok: true },
  'balanced recovery ignores object-like text inside comments');
const singletonBundleOverflow = parseStructuredJsonText('[' + excessiveBundleText + ']');
assertEqual(singletonBundleOverflow.ok, false, 'singleton normalization cannot bypass bundle limits');
assertEqual(singletonBundleOverflow.diagnostic.code, 'json_item_limit');
const singletonCompetitor = parseStructuredJsonText('[{"example":true}]\nAnswer: {"ok":true}');
assertEqual(singletonCompetitor.ok, false, 'a competing singleton object array remains ambiguous after normalization');
assertEqual(singletonCompetitor.diagnostic.code, 'json_ambiguous');
assertEqual(strict.ok, true, 'strict object parses');
assertEqual(strict.repaired, false, 'strict object is not marked repaired');
assertEqual(strict.value.schema, 'recursion.providerTest.v1', 'strict object value returned');

const fenced = parseStructuredJsonText('```json\n{"schema":"recursion.providerTest.v1","ok":true}\n```');
assertEqual(fenced.ok, true, 'fenced json parses');
assertEqual(fenced.value.ok, true, 'fenced json value returned');

const escapedFenced = parseStructuredJsonText('```json\\n{\\n  "schema": "recursion.providerTest.v1",\\n  "ok": true\\n}\\n```');
assertEqual(escapedFenced.ok, true, 'escaped fenced json parses after one transport decode');
assertEqual(escapedFenced.value.schema, 'recursion.providerTest.v1', 'escaped fenced json preserves schema');
assertEqual(escapedFenced.value.ok, true, 'escaped fenced json preserves boolean fields');

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

const partialFusedItems = extractJsonObjectsFromArrayProperty(`{
  "schema": "recursion.cardBundle.v1",
  "snapshotHash": "snapshot-fused-1",
  "items": [
    {"schema":"recursion.card.v1","family":"Scene Frame","role":"sceneFrameCard","promptText":"Recovered first item.","evidenceRefs":["message:8"]},
    {"schema":"recursion.card.v1","family":"Scene Constraints","role":"sceneConstraintsCard","promptText":"Unclosed second item"
`, 'items');
assertEqual(partialFusedItems.length, 1, 'parser recovers complete objects before damaged array tail');
assertEqual(partialFusedItems[0].family, 'Scene Frame', 'parser preserves recovered fused item family');

const smartQuoted = parseStructuredJsonText('\uFEFF{\u201cschema\u201d:\u201crecursion.providerTest.v1\u201d,\u201cok\u201d:true}');
assertEqual(smartQuoted.ok, true, 'BOM and smart quotes are repaired');
assertEqual(smartQuoted.value.schema, 'recursion.providerTest.v1', 'smart quote repair preserves schema');

const missingSchema = parseStructuredJsonText('{"ok":true,}');
assertEqual(missingSchema.ok, true, 'repair does not reject syntactically repairable object');
assertEqual(Object.prototype.hasOwnProperty.call(missingSchema.value, 'schema'), false, 'repair does not fabricate missing schema');

const malformedRedirectRole = parseStructuredJsonText(`{
  "schema": "recursion.editorialDiagnosis.v1",
  "sceneCharacters": [
    {
      "name": "Daniel",
      role: "Documenting, probing magical system implications"
    }
  ]
}`);
assertEqual(malformedRedirectRole.ok, true, 'captured Redirect response repairs an unquoted object key');
assertEqual(malformedRedirectRole.repaired, true, 'unquoted object-key repair is diagnosed');
assertEqual(
  malformedRedirectRole.value.sceneCharacters[0].role,
  'Documenting, probing magical system implications',
  'unquoted object-key repair preserves the model value'
);

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
  candidates: [{ content: { role: 'model', parts: [{ text: '{"ok":true}' }] } }]
}), '{"ok":true}', 'Gemini candidate content parts extracted');

const geminiThoughtResponse = {
  candidates: [{
    content: {
      role: 'model',
      parts: [
        { thought: true, text: 'private model reasoning' },
        { text: '{"ok":true}' }
      ]
    }
  }]
};
assertEqual(extractProviderResponseText(geminiThoughtResponse), '{"ok":true}', 'Gemini thought parts stay out of visible content');
assertEqual(extractProviderResponseReasoning(geminiThoughtResponse), 'private model reasoning', 'Gemini thought parts are diagnosed separately');

const sillyTavernGeminiResponse = {
  choices: [{ message: { content: '{"ok":true}' } }],
  responseContent: {
    role: 'model',
    parts: [
      { thought: true, text: 'private model reasoning' },
      { text: '{"ok":true}' }
    ]
  }
};
assertEqual(extractProviderResponseText(sillyTavernGeminiResponse), '{"ok":true}', 'SillyTavern Gemini envelope preserves visible content');
assertEqual(extractProviderResponseReasoning(sillyTavernGeminiResponse), 'private model reasoning', 'SillyTavern Gemini responseContent thoughts are diagnosed separately');

assertEqual(extractProviderResponseText({
  outputs: [{ content: [{ value: 'output text' }] }]
}), 'output text', 'output content extracted');

assertEqual(extractProviderResponseText({ response: '{"ok":true}' }), '{"ok":true}', 'direct response text extracted');
assertEqual(extractProviderResponseText({ schema: 'recursion.providerTest.v1', ok: true }), '{"schema":"recursion.providerTest.v1","ok":true}', 'object-shaped structured response is serialized');

const nestedRedirect = {
  schema: 'recursion.editorialDiagnosis.v1',
  mode: 'redirect',
  brief: {
    characterPressure: [{
      character: 'Carter',
      immediateWant: 'Test the transport method.',
      wantEvidenceRefs: ['user:0'],
      sourcePressureEffect: 'increasing',
      sourceEvidenceRefs: ['source:0'],
      pressureReason: 'The source postpones the test.'
    }]
  }
};
assertDeepEqual(
  JSON.parse(extractProviderResponseText(nestedRedirect)),
  nestedRedirect,
  'provider response normalization preserves nested Redirect fields'
);

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
  model: 'structured-thinking-model',
  usage: {
    prompt_tokens: 1000,
    completion_tokens: 512,
    total_tokens: 1512,
    completion_tokens_details: { reasoning_tokens: 480 }
  },
  choices: [{ message: { content: '{"schema":"partial"' }, stopReason: 'max_completion_tokens' }]
};
assertDeepEqual(collectProviderResponseFinishReasons(tokenLimited), ['max_completion_tokens'], 'finish reason collected from message stopReason');
assertEqual(isProviderResponseTokenLimitFinishReason('token_limit_reached'), true, 'token-limit variants classified');
const tokenFailure = getProviderResponseFailure(tokenLimited, { providerTitle: 'Utility', maxTokens: 512 });
assertEqual(tokenFailure.code, PROVIDER_RESPONSE_ERROR_CODES.TOKEN_LIMIT, 'token-limit failure classified before parsing');
assertEqual(tokenFailure.model, 'structured-thinking-model', 'token-limit diagnostic includes model');
assertEqual(tokenFailure.promptTokens, 1000, 'token-limit diagnostic includes prompt usage');
assertEqual(tokenFailure.completionTokens, 512, 'token-limit diagnostic includes completion usage');
assertEqual(tokenFailure.reasoningTokens, 480, 'token-limit diagnostic includes reasoning usage');
assertEqual(tokenFailure.totalTokens, 1512, 'token-limit diagnostic includes total usage');
assertEqual(tokenFailure.reasoningLength, 0, 'token-limit diagnostic includes reasoning length');

const emptyFailure = getProviderResponseFailure({ choices: [{ message: { content: '   ' } }] }, { providerTitle: 'Utility' });
assertEqual(emptyFailure.code, PROVIDER_RESPONSE_ERROR_CODES.EMPTY_CONTENT, 'empty visible output classified');

const described = describeProviderResponse(reasoningOnly);
assertEqual(described.visibleContentLength, 0, 'provider description includes visible length');
assertEqual(described.reasoningLength, 'hidden chain of thought'.length, 'provider description includes reasoning length');
assertEqual(Object.hasOwn(described, 'sample'), false, 'provider descriptions never expose visible output samples');

assertEqual(assertProviderResponseText({ text: 'visible' }, { providerTitle: 'Utility' }), 'visible', 'assertProviderResponseText returns visible text');
assertProviderResponseText({ schema: 'recursion.providerTest.v1', ok: true }, { providerTitle: 'Utility' });

// Schema-specific JSON repairs must be added only after a recurring Recursion provider failure proves the need.
// Directive has an operation-array closer repair for its own state-delta schema; Recursion does not port it by default.

console.log('[pass] provider response parser');
