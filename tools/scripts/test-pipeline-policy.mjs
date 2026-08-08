import { resolveEffectivePipelineMode } from '../../src/runtime/pipeline-policy.mjs';
import { assertDeepEqual } from '../../tests/helpers/assert.mjs';

assertDeepEqual(resolveEffectivePipelineMode({
  requestedMode: 'fused',
  utilityCapability: { fusedEligible: false, segmentedEligible: true }
}), {
  requestedMode: 'fused',
  effectiveMode: 'segmented',
  reasonCode: 'profile-not-fused-certified'
}, 'uncertified Fused request downgrades safely');

assertDeepEqual(resolveEffectivePipelineMode({
  requestedMode: 'fused',
  utilityCapability: { fusedEligible: true, segmentedEligible: true }
}), {
  requestedMode: 'fused',
  effectiveMode: 'fused',
  reasonCode: ''
}, 'certified profile keeps Fused');

assertDeepEqual(resolveEffectivePipelineMode({
  requestedMode: 'segmented',
  utilityCapability: { fusedEligible: true, segmentedEligible: true }
}), {
  requestedMode: 'segmented',
  effectiveMode: 'segmented',
  reasonCode: ''
}, 'explicit Segmented mode remains Segmented');

assertDeepEqual(resolveEffectivePipelineMode({
  requestedMode: 'unknown',
  utilityCapability: {}
}), {
  requestedMode: 'segmented',
  effectiveMode: 'segmented',
  reasonCode: ''
}, 'unknown pipeline mode normalizes to Segmented');

console.log('[pass] pipeline policy');
