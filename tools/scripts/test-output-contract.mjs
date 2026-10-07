import assert from 'node:assert/strict';
import { validateOutputShape } from '../../src/providers/output-contract.mjs';
import { failureFrom, providerFailure } from '../../src/failures.mjs';
import { createGenerationRouter } from '../../src/providers.mjs';

const cardSchema = { type: 'object', properties: {
  promptText: { type: 'string' }, evidenceRefs: { type: 'array', items: { type: 'string' } }
}, required: ['promptText', 'evidenceRefs'], additionalProperties: false };
const invalidType = validateOutputShape({ promptText: 'MODEL_PRIVATE_TEXT', evidenceRefs: 27 }, cardSchema);
assert.equal(invalidType.ok, false, 'field types are validated before semantic acceptance');
assert.deepEqual(invalidType.issues.map(({ path, rule }) => ({ path, rule })), [{ path: 'evidenceRefs', rule: 'type' }]);
assert.equal(JSON.stringify(invalidType).includes('MODEL_PRIVATE_TEXT'), false, 'issues contain no rejected model values');
const missingAndUnknown = validateOutputShape({ MODEL_PRIVATE_KEY: 'private' }, cardSchema);
assert.deepEqual(missingAndUnknown.issues.map(({ path, rule }) => ({ path, rule })), [
  { path: 'promptText', rule: 'required' }, { path: 'evidenceRefs', rule: 'required' }, { path: '$', rule: 'additionalProperties' }
], 'missing fields and unknown properties produce schema-owned paths');
assert.equal(JSON.stringify(missingAndUnknown).includes('MODEL_PRIVATE_KEY'), false, 'unknown key names are never exposed');
assert.deepEqual(validateOutputShape({ status: 'MODEL_PRIVATE_TEXT', identity: 'wrong' }, {
  type: 'object', properties: { status: { enum: ['accept', 'revise'] }, identity: { const: 'trusted' } }
}).issues.map(({ path, rule }) => ({ path, rule })), [
  { path: 'status', rule: 'enum' }, { path: 'identity', rule: 'const' }
], 'request enums and constants constrain model identities without echoing values');
assert.deepEqual(validateOutputShape({ short: '', long: 'four', low: -1, high: 9, few: [], many: ['a', 'b'], repeated: [{ x: 1, y: 2 }, { y: 2, x: 1 }] }, {
  type: 'object', properties: { short: { type: 'string', minLength: 1 }, long: { type: 'string', maxLength: 3 },
    low: { type: 'number', minimum: 0 }, high: { type: 'integer', maximum: 8 }, few: { type: 'array', minItems: 1 },
    many: { type: 'array', maxItems: 1 }, repeated: { type: 'array', uniqueItems: true } }
}).issues.map(({ rule }) => rule), ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'uniqueItems'],
'lengths, ranges and structural uniqueness obey the emitted schema subset');
assert.equal(validateOutputShape('bad', { anyOf: [{ type: 'integer' }, { const: 'allowed' }] }).ok,
  false, 'anyOf rejects a value that matches no branch');
assert.equal(validateOutputShape('allowed', { anyOf: [{ type: 'integer' }, { const: 'allowed' }] }).ok, true);
assert.throws(() => validateOutputShape('allowed', { anyOf: [{ const: 'allowed' }, { pattern: 'hidden unsupported branch' }] }),
  /Unsupported output schema keyword/, 'unsupported constructs surface even in unused branches');
const manyFields = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field${i}`, { type: 'string' }]));
const issueLimit = validateOutputShape(Object.fromEntries(Object.keys(manyFields).map((key) => [key, null])), { type: 'object', properties: manyFields });
assert.equal(issueLimit.ok, false);
assert.equal(issueLimit.issues.length, 8, 'feedback is bounded to eight issues');
assert.equal(validateOutputShape(3, { type: 'string' }, { maxIssues: 0 }).ok, false, 'issue omission cannot turn failure into success');
assert.equal(validateOutputShape(null, { type: 'null' }).ok, true);
assert.equal(validateOutputShape(1.5, { type: 'integer' }).ok, false);
assert.equal(validateOutputShape({ text: '😀' }, { type: 'object', properties: { text: { minLength: 1, maxLength: 1 } } }).ok, true,
  'string lengths count Unicode characters');
const safeFailure = failureFrom({ code: 'RECURSION_PROVIDER_SCHEMA_MISMATCH', fieldIssues: [
  { path: 'evidenceRefs', rule: 'type', message: 'MODEL_PRIVATE_TEXT' }
] });
assert.ok(Array.isArray(safeFailure.fieldIssues), 'failure conversion retains useful field issues');
assert.equal(safeFailure.fieldIssues[0].path, 'evidenceRefs');
assert.equal(JSON.stringify(safeFailure).includes('MODEL_PRIVATE_TEXT'), false);
const safeAdditionalSchema = validateOutputShape({ MODEL_PRIVATE_KEY: 9 }, { type: 'object', additionalProperties: { type: 'string' } });
assert.deepEqual(safeAdditionalSchema.issues.map(({ path, rule }) => ({ path, rule })), [{ path: '$', rule: 'type' }],
  'additional-property schemas enforce values while hiding model-owned property names');
const compactVerifier = await createGenerationRouter({ client: { generate: async () => ({ text: '{"failedCardIds":[],"reason":""}' }) } }).generate('editorialVerifier', {
  mode: 'repair', sourceHash: 'source', snapshotHash: 'snapshot', diagnosisHash: 'diagnosis', candidateHash: 'candidate', installedCardIds: ['card-one'], validEvidenceIds: ['card:card-one']
});
assert.equal(compactVerifier.ok, true, 'compact editorial wire schema accepts the locally expanded semantic envelope');
assert.equal(compactVerifier.data.decision, 'accept');
assert.equal(compactVerifier.data.cardOutcomes[0].cardId, 'card-one');
console.log('[pass] output contract');
