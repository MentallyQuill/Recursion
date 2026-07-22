const GENERIC_REASON = /^(failed|failure|warning|caution|needs attention|action failed|provider call failed)[.!]?$/i;
const FAILURE_CODE = /\bRECURSION_[A-Z0-9_]+\b/;

function unhealthy(value = {}) {
  return ['warning', 'error', 'failed'].includes(String(value.severity || value.state || '').toLowerCase())
    || ['warning', 'error'].includes(String(value.outcome || '').toLowerCase());
}

function fail(message) {
  throw new Error(`Readable failure oracle: ${message}`);
}

function flattenSteps(steps = []) {
  return (Array.isArray(steps) ? steps : []).flatMap((step) => [
    step,
    ...flattenSteps(step?.children)
  ]);
}

export function assertEveryUnhealthyStateExplainsWhy({
  activityHistory = [],
  progressRun = {},
  renderedRows = []
} = {}) {
  for (const event of Array.isArray(activityHistory) ? activityHistory : []) {
    if (!unhealthy(event)) continue;
    if (!event?.detail?.failure?.message) fail('unhealthy activity is missing detail.failure');
  }

  const steps = flattenSteps(progressRun?.steps);
  for (const step of steps) {
    if (!unhealthy(step)) continue;
    const reason = String(step.reason || '').trim();
    if (!reason || GENERIC_REASON.test(reason)) fail(`step ${step.id || step.label || 'unknown'} has a generic reason`);
    if (step.id === 'recursion-prompt-ready' && step.state === 'failed') fail('failed settlement mapped to prompt-ready');
  }

  for (const row of Array.isArray(renderedRows) ? renderedRows : []) {
    if (!unhealthy(row)) continue;
    if (FAILURE_CODE.test(String(row.text || ''))) fail('compact UI leaked a diagnostic code');
    const step = steps.find((candidate) => candidate.id === row.id || candidate.label === row.label);
    if (step?.suggestedAction && !String(row.action || '').includes(step.suggestedAction)) {
      fail(`step ${step.id || step.label || 'unknown'} lost its suggested action`);
    }
  }

  return { ok: true };
}
