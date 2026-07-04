export function renderCompactBar({ viewModel = {}, tooltipsEnabled } = {}) {
  return {
    statusText: viewModel.currentStepText || viewModel.standbyStatusText || 'Ready for Recursion.',
    modeLabel: viewModel.modeLabel,
    showStop: Boolean(viewModel.generationStopVisible),
    showForceRegenerate: Boolean(viewModel.forceRegenerateVisible),
    tooltipsEnabled: tooltipsEnabled !== false
  };
}
