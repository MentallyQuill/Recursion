export function resolveEffectivePipelineMode({
  requestedMode = 'segmented',
  utilityCapability = {}
} = {}) {
  const requested = requestedMode === 'fused' ? 'fused' : 'segmented';
  if (requested === 'segmented') {
    return Object.freeze({
      requestedMode: requested,
      effectiveMode: 'segmented',
      reasonCode: ''
    });
  }
  if (utilityCapability?.fusedEligible === true) {
    return Object.freeze({
      requestedMode: requested,
      effectiveMode: 'fused',
      reasonCode: ''
    });
  }
  return Object.freeze({
    requestedMode: requested,
    effectiveMode: 'segmented',
    reasonCode: 'profile-not-fused-certified'
  });
}
