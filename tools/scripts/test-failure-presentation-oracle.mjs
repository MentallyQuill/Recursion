import { assert, assertEqual } from '../../tests/helpers/assert.mjs';
import { assertEveryUnhealthyStateExplainsWhy } from './lib/failure-presentation-oracle.mjs';

const healthy = assertEveryUnhealthyStateExplainsWhy({
  activityHistory: [{
    severity: 'error', phase: 'settled', logicalStage: 'utilityComposing',
    detail: { failure: {
      code: 'RECURSION_PROVIDER_TIMEOUT', stage: 'utility-composing', category: 'provider-timeout',
      message: 'The selected model connection did not respond before the time limit.', retryable: true,
      suggestedAction: 'Check the selected connection profile, then try again.'
    } }
  }],
  progressRun: { steps: [{
    id: 'composing-prompt-packet', label: 'Composing prompt packet', state: 'failed',
    reason: 'The selected model connection did not respond before the time limit.',
    suggestedAction: 'Check the selected connection profile, then try again.',
    failureCode: 'RECURSION_PROVIDER_TIMEOUT'
  }] },
  renderedRows: [{
    label: 'Composing prompt packet', state: 'failed',
    reason: 'The selected model connection did not respond before the time limit.',
    action: 'Try: Check the selected connection profile, then try again.',
    text: 'Composing prompt packet failed The selected model connection did not respond before the time limit. Try: Check the selected connection profile, then try again.'
  }]
});
assertEqual(healthy.ok, true, 'complete readable failure passes oracle');

for (const [name, patch, expected] of [
  ['missing descriptor', { activityHistory: [{ severity: 'error', phase: 'settled', detail: {} }] }, 'missing detail.failure'],
  ['generic reason', { progressRun: { steps: [{ id: 'x', label: 'X', state: 'failed', reason: 'Failed.' }] } }, 'generic reason'],
  ['prompt-ready failure', { progressRun: { steps: [{ id: 'recursion-prompt-ready', label: 'Recursion prompt ready', state: 'failed', reason: 'Connection timed out.' }] } }, 'prompt-ready'],
  ['code leak', { renderedRows: [{ label: 'X', state: 'failed', reason: 'Connection timed out.', action: '', text: 'RECURSION_PROVIDER_TIMEOUT' }] }, 'diagnostic code'],
  ['lost action', {
    progressRun: { steps: [{ id: 'x', label: 'X', state: 'failed', reason: 'Connection timed out.', suggestedAction: 'Try again.' }] },
    renderedRows: [{ label: 'X', state: 'failed', reason: 'Connection timed out.', action: '', text: 'Connection timed out.' }]
  }, 'suggested action']
]) {
  let error = null;
  try {
    assertEveryUnhealthyStateExplainsWhy({ activityHistory: [], progressRun: { steps: [] }, renderedRows: [], ...patch });
  } catch (caught) {
    error = caught;
  }
  assert(error, `${name} is rejected`);
  assert(String(error.message).toLowerCase().includes(expected), `${name} reports ${expected}`);
}

console.log('[pass] failure presentation oracle');
