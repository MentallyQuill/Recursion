export function renderCompactBar({ viewModel = {}, tooltipsEnabled } = {}) {
  const postProcessEnabled = viewModel.postProcess?.enabled === true;
  return {
    statusText: viewModel.currentStepText || viewModel.standbyStatusText || 'Ready for Recursion.',
    modeLabel: viewModel.modeLabel,
    showStop: Boolean(viewModel.generationStopVisible),
    showFreshNextGeneration: Boolean(viewModel.freshNextGenerationVisible),
    freshNextGenerationPending: Boolean(viewModel.freshNextGenerationPending),
    postProcessEnabled,
    postProcessLabel: `Post-process Cards: ${postProcessEnabled ? 'On' : 'Off'}`,
    tooltipsEnabled: tooltipsEnabled !== false
  };
}
