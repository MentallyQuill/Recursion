import { buildDialogueEnhancementRequest, validateDialogueEnhancementResult, DIALOGUE_ENHANCER_SCHEMA } from '../../src/dialogue-enhancement.mjs';
import { buildProseEnhancementRequest } from '../../src/prose-enhancement.mjs';
import { buildGenerationReviewRequest, publicGenerationReviewSnapshot } from '../../src/generation-review.mjs';
import { buildEditorialDiagnosisRequest, buildEditorialPassRequest } from '../../src/editorial-transform.mjs';
import { generationReviewSnapshotHash } from '../../src/generation-review.mjs';
import { hashJson } from '../../src/core.mjs';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

const ending = 'The precaution worked. They left the room together.';
const contextText = `${'Earlier discussion. '.repeat(160)}\n\n${ending}`;
const messages = [{ mesid: 1, role: 'assistant', text: contextText }];
const sourceText = `${'Earlier narration. '.repeat(800)}\n\n${ending}`;
const snapshot = { context: { messages } };
const userSnapshot = { context: { messages: [{ ...messages[0], role: 'user' }] } };
const checks = [
  ['revision cache contract', () => {
    const oldSnapshot = publicGenerationReviewSnapshot({});
    delete oldSnapshot.analysisContractVersion;
    assert(generationReviewSnapshotHash({}) !== hashJson(oldSnapshot), 'full-message revision contract invalidates old hashes even with empty context');
  }],
  ['long narration invariant', () => {
    const result = validateDialogueEnhancementResult({ schema: DIALOGUE_ENHANCER_SCHEMA, text: sourceText.replace(ending, 'They remained trapped inside.') }, { originalText: sourceText });
    assertEqual(result.ok, false, 'dialogue editing cannot change narration after 10000 characters');
    assertEqual(result.error.code, 'RECURSION_DIALOGUE_NARRATION_CHANGED', 'entire narration is protected');
  }],
  ['review context', () => assertEqual(publicGenerationReviewSnapshot(snapshot).context.messages[0].text, contextText, 'review retains complete selected message')],
  ...[buildDialogueEnhancementRequest, buildProseEnhancementRequest].map((build) => [build.name, () => {
    const request = build({ text: sourceText, contextMessages: messages });
    assert(request.prompt.includes(JSON.stringify(contextText).slice(1, -1)) || request.prompt.includes(contextText), 'enhancement context retains message formatting and ending');
    assert(request.prompt.includes(sourceText), 'enhancement target is not clipped');
  }]),
  ['review source', () => assert(buildGenerationReviewRequest({ sourceText, reviewSnapshot: snapshot }).prompt.includes(sourceText), 'review receives entire source')],
  ['editorial user evidence', () => {
    const request = buildEditorialDiagnosisRequest({ mode: 'recompose', sourceText: 'An incorrect response.', snapshot: userSnapshot });
    assert(request.prompt.includes(ending), 'editorial diagnosis can see the ending of the latest user turn');
  }],
  ...[buildEditorialDiagnosisRequest, buildEditorialPassRequest].map((build) => [build.name, () => {
    const request = build({ mode: 'recompose', sourceText, snapshot });
    assertEqual(request.sourceText, sourceText, 'editorial request retains entire source');
  }])
];
const failures = [];
for (const [name, check] of checks) {
  try { check(); } catch (error) { failures.push(name); console.error(`[fail] ${name}: ${error.message.slice(0, 140)}`); }
}
assertEqual(failures.length, 0, 'complete-message context failures');
console.log('[pass] complete-message context');
