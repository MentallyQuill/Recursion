import { createActivityReporter } from '../../src/activity.mjs';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

function assertNoSecret(value, message) {
  const serialized = JSON.stringify(value);
  assert(!serialized.includes('secret-value'), message);
  assert(!serialized.includes('sk-live'), message);
  assert(!serialized.includes('Bearer'), message);
  assert(!serialized.includes('private-key-material'), message);
  assert(serialized.includes('[redacted]'), `${message}: redaction marker present`);
}

const EVENT_KEYS = [
  'runId',
  'phase',
  'operationId',
  'logicalStage',
  'mode',
  'severity',
  'outcome',
  'label',
  'detail',
  'chips',
  'providerLane',
  'composerLane',
  'cardCounts',
  'fallbackReason',
  'recordedAt'
];

function assertEventShape(event, message) {
  assertEqual(Object.keys(event).join('|'), EVENT_KEYS.join('|'), message);
}

const events = [];
const reporter = createActivityReporter({ onEvent: (event) => events.push(event) });
const run = reporter.start({ runId: 'run-1', label: 'Reading current turn...' });
reporter.stage({ runId: run.runId, phase: 'cardBatchRunning', label: 'Generating scene cards...', chips: ['Utility', 'Cards 3'] });
reporter.settle({ runId: run.runId, outcome: 'success', label: 'Recursion prompt ready.' });

assertEqual(events.length, 3, 'start, stage, settle emitted');
assertEqual(reporter.current().phase, 'settled', 'current state settled');
assertEqual(reporter.current().label, 'Recursion prompt ready.', 'settle label preserved');

reporter.stage({ runId: 'stale-run', phase: 'late', label: 'Late result' });
assert(!events.some((event) => event.runId === 'stale-run'), 'stale run ignored');

const ergonomicEvents = [];
const ergonomicReporter = createActivityReporter({ onEvent: (event) => ergonomicEvents.push(event) });
ergonomicReporter.start({ runId: 'ergonomic-run', label: 'Ergonomic start' });
ergonomicReporter.stage({ phase: 'noRunIdStage', label: 'Stage without run id' });
ergonomicReporter.settle({ outcome: 'success', label: 'Settled without run id' });
assertEqual(ergonomicEvents.length, 3, 'stage and settle can use active run without explicit runId');
assertEqual(ergonomicEvents[1].runId, 'ergonomic-run', 'no-runId stage uses active run id');
assertEqual(ergonomicEvents[1].phase, 'noRunIdStage', 'no-runId stage updates active run');
assertEqual(ergonomicEvents[2].phase, 'settled', 'no-runId settle settles active run');
assertEqual(ergonomicReporter.current().severity, 'success', 'no-runId settle maps outcome severity');
assertEventShape(ergonomicEvents[1], 'stage event uses stable key shape');
assertEventShape(ergonomicEvents[2], 'settle event uses stable key shape');

const staleEvents = [];
const staleReporter = createActivityReporter({ onEvent: (event) => staleEvents.push(event) });
const activeRun = staleReporter.start({ runId: 'active-run', label: 'Active work' });
staleReporter.stage({ runId: 'stale-run', phase: 'late-stage', label: 'Late stage' });
staleReporter.settle({ runId: 'stale-run', outcome: 'error', label: 'Late error' });
assertEqual(staleEvents.length, 1, 'stale settle ignored while active run exists');
assertEqual(staleReporter.current().runId, activeRun.runId, 'stale settle does not replace current active run');

const clearEvents = [];
const clearReporter = createActivityReporter({ onEvent: (event) => clearEvents.push(event) });
clearReporter.start({ runId: 'clear-run', label: 'Working' });
clearReporter.clear();
assertEqual(clearReporter.current().phase, 'idle', 'clear resets current to idle');
assertEqual(clearEvents.at(-1).phase, 'idle', 'clear emits idle state');
assertEqual(clearReporter.history().length, 1, 'clear resets history to a single idle event');
assertEqual(clearReporter.history()[0].phase, 'idle', 'clear history contains only idle event');
assertEventShape(clearEvents.at(-1), 'clear idle event uses stable key shape');

const cappedReporter = createActivityReporter();
const cappedRun = cappedReporter.start({ runId: 'capped-run', label: 'Start' });
for (let index = 0; index < 105; index += 1) {
  cappedReporter.stage({ runId: cappedRun.runId, phase: `phase-${index}`, label: `Event ${index}` });
}
assertEqual(cappedReporter.history().length, 100, 'history is capped at 100 events');
assertEqual(cappedReporter.history()[0].phase, 'phase-5', 'oldest history events are dropped first');

const isolatedEvents = [];
const isolatedReporter = createActivityReporter({
  onEvent: (event) => {
    event.label = 'mutated by observer';
    event.chips.push('observer mutation');
    isolatedEvents.push(event);
  }
});
const isolatedRun = isolatedReporter.start({ runId: 'isolation-run', label: 'Original label', chips: ['Utility'] });
assertEqual(isolatedReporter.current().label, 'Original label', 'onEvent cannot mutate current state');
assertEqual(isolatedReporter.current().chips.length, 1, 'onEvent cannot mutate current chips');
const currentSnapshot = isolatedReporter.current();
currentSnapshot.label = 'mutated snapshot';
currentSnapshot.chips.push('snapshot mutation');
assertEqual(isolatedReporter.current().label, 'Original label', 'current returns a clone');
assertEqual(isolatedReporter.current().chips.length, 1, 'current clone mutation is isolated');
const historySnapshot = isolatedReporter.history();
historySnapshot[0].label = 'mutated history snapshot';
historySnapshot[0].chips.push('history mutation');
assertEqual(isolatedReporter.history()[0].label, 'Original label', 'history returns clones');
assertEqual(isolatedReporter.history()[0].chips.length, 1, 'history clone mutation is isolated');
isolatedReporter.settle({ runId: isolatedRun.runId, outcome: 'success', label: 'Done' });

const secretEvents = [];
const secretReporter = createActivityReporter({ onEvent: (event) => secretEvents.push(event) });
const secretRun = secretReporter.start({
  runId: 'secret-run',
  label: `secret-value ${'A'.repeat(240)}`,
  mode: 'bad-mode',
  severity: 'bad-severity',
  providerLane: 'bad-provider',
  composerLane: 'bad-composer',
  detail: {
    apiKey: 'secret-value',
    nested: { authorization: 'secret-value' },
    message: 'Bearer neutral-token',
    notes: ['secret-value', { note: 'sk-live-neutral-key' }],
    safe: 'visible'
  },
  fallbackReason: `Bearer fallback-token ${'B'.repeat(600)}`,
  chips: [`private-key-material ${'C'.repeat(120)}`],
  cardCounts: { total: 3, token: 'secret-value' }
});
assertEqual(secretRun.mode, 'foreground', 'invalid start mode falls back to foreground');
assertEqual(secretRun.severity, 'info', 'invalid severity falls back to info');
assertEqual(secretRun.providerLane, null, 'invalid provider lane is omitted as null');
assertEqual(secretRun.composerLane, null, 'invalid composer lane is omitted as null');
assertEqual(secretRun.label.length, 160, 'labels are truncated to exact cap');
assert(secretRun.label.endsWith('...'), 'truncated labels use ellipsis');
assertEqual(secretRun.fallbackReason.length, 240, 'fallback reason is truncated to exact cap');
assert(secretRun.fallbackReason.endsWith('...'), 'truncated fallback reason uses ellipsis');
assertEqual(secretRun.chips[0].length, 80, 'chips are truncated to exact cap');
assertNoSecret(secretRun.detail, 'detail secrets are redacted');
assertNoSecret(secretRun.cardCounts, 'card count secrets are redacted');
assertNoSecret(secretRun, 'full event display fields redact seeded secret text');
assertEventShape(secretRun, 'activity event uses stable key shape');

const nonJsonReporter = createActivityReporter();
const nonJsonRun = nonJsonReporter.start({
  runId: 'non-json-run',
  label: 'Non JSON',
  detail: { count: 1n, apiKey: 'secret-value' },
  cardCounts: { count: 1n }
});
assertEqual(nonJsonRun.detail, null, 'non-json detail fails soft to null');
assertEqual(nonJsonRun.cardCounts, null, 'non-json cardCounts fails soft to null');
assertEventShape(nonJsonRun, 'non-json fallback event uses stable key shape');

const laneReporter = createActivityReporter();
const laneRun = laneReporter.start({
  phase: 'reading',
  mode: 'review',
  severity: 'warning',
  providerLane: 'utility',
  composerLane: 'local',
  label: 'Lane check'
});
laneReporter.stage({
  runId: laneRun.runId,
  phase: 'reasoning',
  mode: 'foreground',
  severity: 'error',
  providerLane: 'reasoner',
  composerLane: 'reasoner',
  label: 'Reasoning'
});
assertEqual(laneReporter.current().mode, 'foreground', 'valid mode preserved');
assertEqual(laneReporter.current().severity, 'error', 'valid severity preserved');
assertEqual(laneReporter.current().providerLane, 'reasoner', 'valid provider lane preserved');
assertEqual(laneReporter.current().composerLane, 'reasoner', 'valid composer lane preserved');

const guidanceLaneReporter = createActivityReporter();
const guidanceLaneRun = guidanceLaneReporter.start({
  runId: 'guidance-lane-run',
  label: 'Guidance lane start'
});
guidanceLaneReporter.stage({
  runId: guidanceLaneRun.runId,
  phase: 'guidanceFallback',
  composerLane: 'guidance',
  label: 'Guidance fallback'
});
assertEqual(
  guidanceLaneReporter.current().composerLane,
  'guidance',
  'guidance composer lane is preserved for fallback prompt composition'
);

const outcomes = [];
const outcomeReporter = createActivityReporter({ onEvent: (event) => outcomes.push(event) });
const warningRun = outcomeReporter.start({ runId: 'warning-run', label: 'Warning run' });
outcomeReporter.settle({ runId: warningRun.runId, outcome: 'warning', label: 'Warned' });
const errorRun = outcomeReporter.start({ runId: 'error-run', label: 'Error run' });
outcomeReporter.settle({ runId: errorRun.runId, outcome: 'error', label: 'Errored' });
const explainedRun = outcomeReporter.start({ runId: 'explained-run', label: 'Explained run' });
outcomeReporter.settle({
  runId: explainedRun.runId,
  outcome: 'error',
  label: 'Provider failed',
  detail: {
    failure: {
      code: 'RECURSION_PROVIDER_TIMEOUT',
      stage: 'editorial-writer',
      category: 'provider-timeout',
      message: 'Provider call timed out.',
      retryable: true
    }
  }
});
const skippedRun = outcomeReporter.start({ runId: 'skipped-run', label: 'Skipped run' });
outcomeReporter.settle({ runId: skippedRun.runId, outcome: 'skipped', label: 'Skipped' });
assertEqual(outcomes.find((event) => event.runId === 'warning-run' && event.phase === 'settled').severity, 'warning', 'warning outcome maps to warning severity');
assertEqual(outcomes.find((event) => event.runId === 'error-run' && event.phase === 'settled').severity, 'error', 'error outcome maps to error severity');
assertEqual(
  outcomes.find((event) => event.runId === 'warning-run' && event.phase === 'settled').detail.failure.message,
  'Unexpected internal failure (RECURSION_ACTIVITY_REASON_MISSING).',
  'warning settlement without a reason receives an explicit internal failure descriptor'
);
assertEqual(
  outcomes.find((event) => event.runId === 'error-run' && event.phase === 'settled').detail.failure.message,
  'Unexpected internal failure (RECURSION_ACTIVITY_REASON_MISSING).',
  'error settlement without a reason receives an explicit internal failure descriptor'
);
assertEqual(
  outcomes.find((event) => event.runId === 'explained-run' && event.phase === 'settled').detail.failure.message,
  'Provider call timed out.',
  'existing failure descriptor remains authoritative'
);
assertEqual(outcomes.find((event) => event.runId === 'skipped-run' && event.phase === 'settled').severity, 'info', 'skipped outcome keeps neutral severity');
assertEqual(outcomes.find((event) => event.runId === 'skipped-run' && event.phase === 'settled').outcome, 'skipped', 'skipped outcome is preserved');

const throwingReporter = createActivityReporter({
  onEvent: () => {
    throw new Error('observer failed');
  }
});
const throwingRun = throwingReporter.start({ runId: 'throwing-run', label: 'Observer failure tolerated' });
throwingReporter.stage({ runId: throwingRun.runId, phase: 'still-running', label: 'Still running' });
throwingReporter.settle({ runId: throwingRun.runId, outcome: 'success', label: 'Still settled' });
assertEqual(throwingReporter.current().phase, 'settled', 'onEvent errors are best-effort');

const rejectingReporter = createActivityReporter({
  onEvent: () => Promise.reject(new Error('observer rejected'))
});
const rejectingRun = rejectingReporter.start({ runId: 'rejecting-run', label: 'Observer rejection tolerated' });
rejectingReporter.stage({ phase: 'still-running', label: 'Still running after rejection' });
rejectingReporter.settle({ outcome: 'success', label: 'Still settled after rejection' });
await new Promise((resolve) => setTimeout(resolve, 0));
assertEqual(rejectingReporter.current().phase, 'settled', 'async onEvent rejections are best-effort');
assertEqual(rejectingReporter.current().runId, rejectingRun.runId, 'async rejection reporter keeps active run state through settle');

const storageProgressReporter = createActivityReporter();
const storageRun = storageProgressReporter.start({ runId: 'storage-progress-run', label: 'Storage run' });
const storageProgress = storageProgressReporter.stage({
  runId: storageRun.runId,
  phase: 'storageProgress',
  operationId: 'storage-op-1',
  logicalStage: 'Updating scene cache',
  label: 'Updating scene cache...',
  detail: {
    kind: 'sceneCache',
    key: 'recursion-scene-should-not-leak.v1.json'
  }
});
assertEqual(storageProgress.operationId, 'storage-op-1', 'activity preserves storage operation id');
assertEqual(storageProgress.logicalStage, 'Updating scene cache', 'activity preserves logical storage stage');
assertEventShape(storageProgress, 'storage progress event uses stable key shape');

console.log('[pass] activity');
