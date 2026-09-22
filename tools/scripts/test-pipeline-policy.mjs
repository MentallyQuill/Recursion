import { resolveEffectivePipelineMode } from '../../src/runtime/pipeline-policy.mjs';
import { assertDeepEqual } from '../../tests/helpers/assert.mjs';
const unconfigured = { selectedLane: 'utility', profileIdHash: '', configHash: '', certificationState: 'not-run' };

assertDeepEqual(resolveEffectivePipelineMode({
  requestedMode: 'fused',
  selectedCapability: { fusedEligible: false, segmentedEligible: true }
}), {
  ...unconfigured,
  requestedMode: 'fused',
  effectiveMode: 'segmented',
  reasonCode: 'profile-not-fused-certified'
}, 'uncertified Fused request downgrades safely');

assertDeepEqual(resolveEffectivePipelineMode({
  requestedMode: 'fused',
  selectedCapability: { fusedEligible: true, segmentedEligible: true }
}), {
  ...unconfigured,
  requestedMode: 'fused',
  effectiveMode: 'fused',
  reasonCode: ''
}, 'certified effective provider lane keeps Fused');

assertDeepEqual(resolveEffectivePipelineMode({
  requestedMode: 'segmented',
  selectedCapability: { fusedEligible: true, segmentedEligible: true }
}), {
  ...unconfigured,
  requestedMode: 'segmented',
  effectiveMode: 'segmented',
  reasonCode: ''
}, 'explicit Segmented mode remains Segmented');

assertDeepEqual(resolveEffectivePipelineMode({
  requestedMode: 'unknown',
  selectedCapability: {}
}), {
  ...unconfigured,
  requestedMode: 'segmented',
  effectiveMode: 'segmented',
  reasonCode: ''
}, 'unknown pipeline mode normalizes to Segmented');

console.log('[pass] pipeline policy');
