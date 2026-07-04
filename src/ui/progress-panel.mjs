export function progressPanelState(viewModel = {}) {
  return {
    title: viewModel.progressRun?.title || 'Recursion',
    subtitle: viewModel.progressRun?.subtitle || '',
    steps: Array.isArray(viewModel.progressRun?.steps) ? viewModel.progressRun.steps : []
  };
}
