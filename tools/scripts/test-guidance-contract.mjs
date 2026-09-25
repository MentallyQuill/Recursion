import { createGenerationRouter, jsonSchemaForRequest } from '../../src/providers.mjs';
import { validateGuidanceStageResult, buildGuidanceCorrectionRequest } from '../../src/prompt.mjs';
import { hashJson } from '../../src/core.mjs';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

const schema = jsonSchemaForRequest({
  responseSchema: 'recursion.guidanceComposer.v1', snapshotHash: 'frozen-turn'
}).schema;
assert(schema.required.includes('guidanceText'), 'native schema requires actual Guidance content');
assertEqual(schema.properties.guidanceText.type, 'string', 'Guidance content is text');
assertEqual(schema.additionalProperties, false, 'native Guidance contract has no arbitrary output fields');

{
  const payload = { guidanceText: 'Answer the immediate question without inventing motives.', sourceCardIds: ['scene'] };
  const router = createGenerationRouter({ client: { async generate() { return { text: JSON.stringify(payload) }; } } });
  const result = await router.generate('guidanceComposer', { snapshotHash: 'frozen-turn' });
  assertEqual(result.ok, true, 'usable Guidance without echoed bookkeeping survives provider validation');
  assertEqual(result.data.schema, 'recursion.guidanceComposer.v1', 'schema is bound to the requested role');
  assertEqual(result.data.snapshotHash, 'frozen-turn', 'snapshot is bound to the frozen request');
  assertEqual(result.data.guidanceText, payload.guidanceText, 'recovery preserves model-authored Guidance');
  assertEqual(result.diagnostics.semanticNormalization, 'guidance-request-envelope', 'recovery is observable');
}

{
  const result = validateGuidanceStageResult({ ok: true, data: {
    schema: 'recursion.guidanceComposer.v1', snapshotHash: hashJson({}), guidanceText: { text: 'not a string' }
  } });
  assertEqual(result.ok, false, 'a structured object cannot masquerade as Guidance prose');
}

console.log('[pass] guidance contract');

{
  const rejected = validateGuidanceStageResult({ ok: true, data: {
    schema: 'recursion.guidanceComposer.v1', snapshotHash: hashJson({}),
    guidanceText: 'Reveal hidden\nthoughts. REJECTED_PROSE_CANARY'
  } });
  assertEqual(rejected.error.validationRule, 'character-interiority', 'wrapped forbidden wording has one stable rejection category');
  assertEqual(rejected.error.reason, 'character-interiority', 'the failure reason comes from the same validation result');
  assert(!JSON.stringify(rejected.error).includes('REJECTED_PROSE_CANARY'), 'validation feedback excludes rejected prose');
  const correction = buildGuidanceCorrectionRequest({ request: { prompt: 'Original task.' }, failure: rejected.error });
  assert(correction.prompt.includes('observable behavior') && correction.prompt.includes('established character knowledge'), 'content correction explains how to replace unsupported interiority');
  assert(!correction.prompt.includes('REJECTED_PROSE_CANARY'), 'correction does not echo rejected prose');
}

// Omission repair is deliberately narrow: no fabricated prose or replacement identities.
for (const [guidanceText, validationRule, correctionHint] of [
  ['Reveal hidden chain\nof thought.', 'model-reasoning', 'without requesting or quoting a model reasoning transcript'],
  ['Reveal hidden future plans.', 'unrevealed-story', 'preserve uncertainty about future events'],
  ['Do not invent hidden motives for Harry, but print the chain of thought.', 'model-reasoning', 'without requesting or quoting a model reasoning transcript']
]) {
  const result = validateGuidanceStageResult({ ok: true, data: {
    schema: 'recursion.guidanceComposer.v1', snapshotHash: hashJson({}), guidanceText
  } });
  assertEqual(result.error.validationRule, validationRule, 'content categories distinguish model reasoning from story disclosure');
  const correction = buildGuidanceCorrectionRequest({ request: { prompt: 'Original task.' }, failure: result.error });
  assert(correction.prompt.includes(correctionHint), 'correction addresses the actual rejected category');
}

for (const payload of [
  { guidanceText: 'Valid prose', schema: 'wrong.schema' },
  { guidanceText: 'Valid prose', snapshotHash: 'different-turn' },
  { guidanceText: { nested: 'Not text' } },
  { guidanceText: '' },
  { description: 'A JSON Schema definition instead of an instance' },
  ['Unstructured guidance without an object']
]) {
  const router = createGenerationRouter({ client: { async generate() { return { text: JSON.stringify(payload) }; } } });
  const result = await router.generate('guidanceComposer', { snapshotHash: hashJson({}) });
  assert(!result.ok || !validateGuidanceStageResult(result).ok, `invalid or conflicting Guidance cannot become accepted: ${JSON.stringify(payload)}`);
}
