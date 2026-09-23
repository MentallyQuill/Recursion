import { hashJson } from '../core.mjs';

export function pipelineExecutionLabel(value) {
  if (!value) return '';
  const decision = normalizePipelineDecision(value);
  const name = (mode) => mode === 'fused' ? 'Fused' : 'Segmented';
  const lane = decision.selectedLane === 'reasoner' ? 'Reasoner' : 'Utility';
  return decision.requestedMode !== decision.effectiveMode
    ? `${name(decision.requestedMode)} → ${name(decision.effectiveMode)} · ${lane}`
    : `${name(decision.effectiveMode)} · ${lane}`;
}

export function normalizePipelineDecision(value = {}) {
  return {
    requestedMode: value.requestedMode === 'fused' ? 'fused' : 'segmented',
    effectiveMode: value.effectiveMode === 'fused' ? 'fused' : 'segmented',
    selectedLane: value.selectedLane === 'reasoner' ? 'reasoner' : 'utility',
    profileIdHash: String(value.profileIdHash || '').slice(0, 180),
    configHash: String(value.configHash || '').slice(0, 180),
    certificationState: String(value.certificationState || 'not-run').slice(0, 80),
    reasonCode: String(value.reasonCode || '').slice(0, 120)
  };
}

export function resolveEffectivePipelineMode({
  requestedMode = 'segmented',
  selectedCapability = {},
  selectedProfileId = ''
} = {}) {
  const requested = requestedMode === 'fused' ? 'fused' : 'segmented';
  const details = {
    selectedLane: selectedCapability.lane === 'reasoner' ? 'reasoner' : 'utility',
    profileIdHash: selectedProfileId ? hashJson(selectedProfileId) : '',
    configHash: selectedCapability.configHash || '',
    certificationState: selectedCapability.state || 'not-run'
  };
  return Object.freeze({
    ...details,
    requestedMode: requested,
    effectiveMode: requested,
    reasonCode: ''
  });
}
