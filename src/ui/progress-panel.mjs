import { providerQueueLine } from './provider-panel.mjs';

export function progressRecoveryLines(view = {}, {now = Date.now} = {}) {
  const execution = view.execution;
  if (!['running','paused'].includes(execution?.state)) return {wait:null,allowance:null};
  const waiting=[];
  const budget=execution.recoveryBudget;
  const currentTime=now();
  const pending=Object.values(execution.stageRecords || {}).filter(stage => stage.kind === 'model'
    && ['pending','running','failed'].includes(stage.state));
  for (const lane of new Set(pending.map(stage=>stage.providerLane).filter(lane=>['utility','reasoner'].includes(lane)))) {
    const queue=view.providerOperations?.queues?.[lane];
    if (providerQueueLine(queue)) waiting.push(queue);
  }
  for (const stage of pending) {
    const persisted=budget?.providerCooldowns?.[stage.providerKey];
    const failureWait=stage.failure?.code === 'RECURSION_PROVIDER_RATE_LIMIT' ? stage.failure.retryNotBefore : null;
    const retryNotBefore=Math.max(Number.isFinite(persisted) ? persisted : 0,Number.isFinite(failureWait) ? failureWait : 0);
    const cooldownRemainingMs = Math.max(0,retryNotBefore-currentTime);
    if (cooldownRemainingMs > 0) waiting.push({available:true,cooldownRemainingMs});
  }
  const longest = waiting.sort((a,b) => b.cooldownRemainingMs - a.cooldownRemainingMs)[0];
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
