import {
  MAX_POST_PROCESS_GUIDANCE_LENGTH,
  POST_PROCESS_GUIDANCE_SCHEMA,
  buildPostProcessGuidanceRequest,
  postProcessGuidanceRoute
} from '../../src/post-process-guidance.mjs';
import { createGenerationRouter } from '../../src/providers.mjs';
import {
  reasoningIntentForLevel,
  reasoningRequestMetadata
} from '../../src/reasoning-policy.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

const baseInput = {
  snapshotHash: 'snapshot-guidance-v1',
  sourceHash: 'source-guidance-v1',
  reasoningLevel: 'medium',
  supportingContext: {
    latestUserMessage: 'Keep the choice with the player.',
    boundedPriorMessages: ['The door is already open.'],
    characterContext: 'Mara speaks plainly.',
    preProcessPromptPacket: 'Preserve the established objective.',
    storyForm: { tense: 'past', pov: 'third-person-limited' }
  },
  categories: [{
    id: 'natural-prose',
    name: 'Natural Prose',
    cards: [{
      id: 'cut-echoes',
      name: 'Cut Echoes',
      promptText: 'Remove redundant restatement.'
    }]
  }],
  draft: 'Mara repeated the warning in three different ways.'
};

assertDeepEqual(
  postProcessGuidanceRoute('low'),
  { lane: 'utility', roleId: 'postProcessGuidanceUtility' },
  'Low routes post-process guidance to Utility'
);
assertDeepEqual(
  postProcessGuidanceRoute('medium'),
  { lane: 'utility', roleId: 'postProcessGuidanceUtility' },
  'Medium routes post-process guidance to Utility'
);
assertDeepEqual(
  postProcessGuidanceRoute('high'),
  { lane: 'reasoner', roleId: 'postProcessGuidanceReasoner' },
  'High routes post-process guidance to Reasoner'
);
assertDeepEqual(
  postProcessGuidanceRoute('ultra'),
  { lane: 'reasoner', roleId: 'postProcessGuidanceReasoner' },
  'Ultra routes post-process guidance to Reasoner'
);

assertEqual(reasoningIntentForLevel('low', 'post-process'), 'minimal', 'Low post-process reasoning is minimal');
assertEqual(reasoningIntentForLevel('medium', 'post-process'), 'medium', 'Medium post-process reasoning is medium');
assertEqual(reasoningIntentForLevel('high', 'post-process'), 'medium', 'High post-process reasoning is medium');
assertEqual(reasoningIntentForLevel('ultra', 'post-process'), 'high', 'Ultra post-process reasoning is high');
assertDeepEqual(
  reasoningRequestMetadata('ultra', 'post-process'),
  { reasoningCategory: 'post-process', reasoningIntent: 'high' },
  'post-process request metadata keeps its dedicated category'
);

const request = buildPostProcessGuidanceRequest(baseInput);
assertEqual(request.snapshotHash, baseInput.snapshotHash, 'guidance request binds the frozen snapshot hash');
assertEqual(request.sourceHash, baseInput.sourceHash, 'guidance request binds the source hash');
assertEqual(request.reasoningLevel, 'medium', 'guidance request binds its frozen reasoning level');
assertEqual(request.reasoningCategory, 'post-process', 'guidance request uses post-process reasoning category');
assertEqual(request.reasoningIntent, 'medium', 'guidance request uses level-specific reasoning intent');
assertEqual(request.jsonSchema.properties.schema.const, POST_PROCESS_GUIDANCE_SCHEMA, 'guidance request carries the minimal response schema');
assertEqual(request.jsonSchema.properties.guidanceText.maxLength, MAX_POST_PROCESS_GUIDANCE_LENGTH, 'guidance response schema bounds guidance text');
assert(request.prompt.includes('Analyze where the selected revision cards apply.'), 'guidance prompt asks where and how cards apply');
assert(request.prompt.includes('Do not rewrite the story response.'), 'guidance prompt forbids story authorship');
assert(request.prompt.includes('Preserve unsupported material and user agency.'), 'guidance prompt preserves unsupported material and agency');
assert(request.prompt.includes('Cut Echoes'), 'guidance prompt includes ordered card identity');
assert(request.prompt.includes('Remove redundant restatement.'), 'guidance prompt includes ordered card instructions');
assert(request.prompt.includes(baseInput.draft), 'guidance prompt includes the current writable draft');

function response(fields = {}) {
  return JSON.stringify({
    schema: POST_PROCESS_GUIDANCE_SCHEMA,
    snapshotHash: baseInput.snapshotHash,
    sourceHash: baseInput.sourceHash,
    guidanceText: 'Apply Cut Echoes to the repeated warning while preserving its consequence.',
    ...fields
  });
}

async function routeResult(rawText, overrides = {}) {
  const router = createGenerationRouter({
    client: {
      async generate() {
        return { text: rawText };
      }
    }
  });
  return router.generate(
    'postProcessGuidanceUtility',
    buildPostProcessGuidanceRequest({ ...baseInput, ...overrides }),
    { maxAttempts: 1, allowStructuredRecovery: false }
  );
}

for (const [name, rawText, expectedCode] of [
  ['malformed', 'not-json', 'RECURSION_JSON_PARSE_FAILED'],
  ['wrong schema', response({ schema: 'recursion.storyRewrite.v1' }), 'RECURSION_PROVIDER_SCHEMA_MISMATCH'],
  ['stale snapshot hash', response({ snapshotHash: 'stale-snapshot' }), 'RECURSION_POST_PROCESS_GUIDANCE_INVALID'],
  ['stale source hash', response({ sourceHash: 'stale-source' }), 'RECURSION_POST_PROCESS_GUIDANCE_INVALID'],
  ['empty guidance', response({ guidanceText: '   ' }), 'RECURSION_POST_PROCESS_GUIDANCE_INVALID'],
  ['story rewrite field', response({ text: 'Mara rewrote the whole scene.' }), 'RECURSION_POST_PROCESS_GUIDANCE_INVALID']
]) {
  const result = await routeResult(rawText);
  assertEqual(result.ok, false, `${name} guidance output fails`);
  assertEqual(result.error.code, expectedCode, `${name} guidance output has a stable failure code`);
}

for (const [field, values] of Object.entries({
  schema: [{ value: POST_PROCESS_GUIDANCE_SCHEMA }, 7, true],
  snapshotHash: [{ value: baseInput.snapshotHash }, 7, true],
  sourceHash: [{ value: baseInput.sourceHash }, 7, true],
  guidanceText: [{ value: 'Apply the card.' }, 7, true]
})) {
  for (const value of values) {
    const result = await routeResult(response({ [field]: value }));
    assertEqual(result.ok, false, `${field} rejects ${typeof value} values`);
    assertEqual(
      result.error.code,
      'RECURSION_POST_PROCESS_GUIDANCE_INVALID',
      `${field} wrong-type output has a stable failure code`
    );
  }
}

const boundedGuidance = `  ${'g'.repeat(MAX_POST_PROCESS_GUIDANCE_LENGTH + 20)}  `;
const boundedResult = await routeResult(response({ guidanceText: boundedGuidance }));
assertEqual(boundedResult.ok, true, 'valid guidance envelope succeeds');
assertEqual(boundedResult.data.guidanceText.length, MAX_POST_PROCESS_GUIDANCE_LENGTH, 'valid guidance is bounded');
assertEqual(boundedResult.data.guidanceText, boundedResult.data.guidanceText.trim(), 'valid guidance is trimmed');
assertDeepEqual(
  Object.keys(boundedResult.data).sort(),
  ['guidanceText', 'schema', 'snapshotHash', 'sourceHash'],
  'normalized guidance remains a minimal envelope'
);
assertEqual(boundedResult.text, JSON.stringify(boundedResult.data), 'router response text is the structured envelope');
assert(boundedResult.text !== boundedResult.data.guidanceText, 'router response text is not treated as rewritten story prose');

const retryCalls = [];
const retryRouter = createGenerationRouter({
  client: {
    async generate(roleId, attemptRequest) {
      retryCalls.push({ roleId, requestLane: attemptRequest.lane });
      return {
        text: retryCalls.length === 1
          ? response({ guidanceText: '' })
          : response({ guidanceText: 'Apply the card only to the repeated warning.' })
      };
    }
  }
});
const highRoute = postProcessGuidanceRoute('high');
const retried = await retryRouter.generate(
  highRoute.roleId,
  { ...buildPostProcessGuidanceRequest({ ...baseInput, reasoningLevel: 'high' }), lane: highRoute.lane },
  { maxAttempts: 2, allowStructuredRecovery: true }
);
assertEqual(retried.ok, true, 'one structured recovery succeeds on the second attempt');
assertEqual(retryCalls.length, 2, 'guidance uses at most the router two-attempt budget');
assertDeepEqual(
  retryCalls.map(({ roleId, requestLane }) => [roleId, requestLane]),
  [
    ['postProcessGuidanceReasoner', 'reasoner'],
    ['postProcessGuidanceReasoner', 'reasoner']
  ],
  'guidance retry never changes role or lane'
);

console.log('[pass] post-process guidance');
