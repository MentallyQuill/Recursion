import { createGenerationRouter, jsonSchemaForRequest } from '../../src/providers.mjs';
import { validateGuidanceStageResult } from '../../src/prompt.mjs';
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

// Omission repair is deliberately narrow: no fabricated prose or replacement identities.
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
