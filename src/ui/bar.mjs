export function renderCompactBar({ viewModel = {}, tooltipsEnabled } = {}) {
  return {
    statusText: viewModel.currentStepText || viewModel.standbyStatusText || 'Ready for Recursion.',
    modeLabel: viewModel.modeLabel,
    showStop: Boolean(viewModel.generationStopVisible),
    showFreshNextGeneration: Boolean(viewModel.freshNextGenerationVisible),
    freshNextGenerationPending: Boolean(viewModel.freshNextGenerationPending),
    tooltipsEnabled: tooltipsEnabled !== false
  };
}
