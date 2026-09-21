import {
  minimumOutputBudgetForRole,
  outputBudgetForRequest
} from '../../src/providers/stage-output-budgets.mjs';
import { assertEqual } from '../../tests/helpers/assert.mjs';

assertEqual(outputBudgetForRequest('providerTest', {}, 8192), 128, 'provider test is small');
assertEqual(outputBudgetForRequest('sceneFrameCard', {}, 8192), 8192, 'single card uses lane ceiling');
assertEqual(outputBudgetForRequest('fusedCardBundle', {
  requestedCards: Array.from({ length: 10 }, (_, index) => ({ family: `F${index}` }))
}, 8192), 8192, 'bundle uses lane ceiling');
assertEqual(outputBudgetForRequest('fusedCardBundle', {
  requestedCards: Array.from({ length: 10 }, (_, index) => ({ family: `F${index}` }))
}, 4096), 4096, 'lane ceiling wins');
assertEqual(outputBudgetForRequest('editorialTransformer', {
  sourceText: 'x'.repeat(12000)
}, 8192), 8192, 'editorial transform uses lane ceiling');
assertEqual(outputBudgetForRequest('sceneFrameCard', { responseLength: 512 }, 8192), 512, 'explicit smaller budget survives');
assertEqual(outputBudgetForRequest('sceneFrameCard', { responseLength: 12000 }, 4096), 4096, 'explicit budget cannot exceed lane ceiling');
assertEqual(outputBudgetForRequest('utilityArbiter', {}, 8192), 8192, 'Utility Arbiter uses lane ceiling');
assertEqual(minimumOutputBudgetForRole('providerTest'), 64, 'provider test minimum is small');
assertEqual(minimumOutputBudgetForRole('unknown'), 384, 'unknown role has conservative minimum');

console.log('[pass] stage output budgets');

for (const role of ['sceneFrameCard', 'guidanceComposer', 'reasonerComposer', 'cardAuthoringAssist', 'editorialTransformer', 'fusedCardBundle']) {
  assertEqual(outputBudgetForRequest(role, {}, 16000), 16000, `${role} honors configured ceiling`);
}
assertEqual(outputBudgetForRequest('sceneFrameCard', { maxTokens: 700 }, 16000), 700, 'explicit maxTokens survives');
