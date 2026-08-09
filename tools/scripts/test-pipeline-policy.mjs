import { resolveEffectivePipelineMode } from '../../src/runtime/pipeline-policy.mjs';
import { assertDeepEqual } from '../../tests/helpers/assert.mjs';

assertDeepEqual(resolveEffectivePipelineMode({
  requestedMode: 'fused',
  selectedCapability: { fusedEligible: false, segmentedEligible: true }
}), {
  requestedMode: 'fused',
  effectiveMode: 'segmented',
  reasonCode: 'profile-not-fused-certified'
}, 'uncertified Fused request downgrades safely');

assertDeepEqual(resolveEffectivePipelineMode({
  requestedMode: 'fused',
  selectedCapability: { fusedEligible: true, segmentedEligible: true }
}), {
  requestedMode: 'fused',
  effectiveMode: 'fused',
  reasonCode: ''
}, 'certified effective provider lane keeps Fused');

assertDeepEqual(resolveEffectivePipelineMode({
  requestedMode: 'segmented',
  selectedCapability: { fusedEligible: true, segmentedEligible: true }
}), {
  requestedMode: 'segmented',
  effectiveMode: 'segmented',
  reasonCode: ''
}, 'explicit Segmented mode remains Segmented');

assertDeepEqual(resolveEffectivePipelineMode({
  requestedMode: 'unknown',
  selectedCapability: {}
}), {
  requestedMode: 'segmented',
  effectiveMode: 'segmented',
  reasonCode: ''
}, 'unknown pipeline mode normalizes to Segmented');

console.log('[pass] pipeline policy');
