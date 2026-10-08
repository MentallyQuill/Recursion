import { providerQueueLine } from './provider-panel.mjs';

export function progressRecoveryLines(view = {}, {now = Date.now} = {}) {
  const execution = view.execution;
  if (!['running','paused'].includes(execution?.state)) return {wait:null,allowance:null};
  const waiting = Object.values(view.providerOperations?.queues || {}).filter(queue => providerQueueLine(queue));
  for (const stage of Object.values(execution.stageRecords || {})) {
    if (stage.failure?.code !== 'RECURSION_PROVIDER_RATE_LIMIT' || !Number.isFinite(stage.failure.retryNotBefore)) continue;
    const cooldownRemainingMs = Math.max(0, stage.failure.retryNotBefore - now());
    if (cooldownRemainingMs > 0) waiting.push({available:true,cooldownRemainingMs});
  }
  const longest = waiting.sort((a,b) => b.cooldownRemainingMs - a.cooldownRemainingMs)[0];
  const budget = execution.recoveryBudget;
  const allowance = Number.isFinite(budget?.recoveryLimit) && Number.isFinite(budget?.recoveryUsed)
    ? `Recovery allowance · ${Math.max(0, Math.trunc(budget.recoveryLimit - budget.recoveryUsed))} of ${Math.max(0, Math.trunc(budget.recoveryLimit))} additional calls remaining`
    : null;
  return {wait:providerQueueLine(longest),allowance};
}

export function progressPanelState(viewModel = {}) {
  return {
    title: viewModel.progressRun?.title || 'Recursion',
    subtitle: viewModel.progressRun?.subtitle || '',
    steps: Array.isArray(viewModel.progressRun?.steps) ? viewModel.progressRun.steps : []
  };
}
