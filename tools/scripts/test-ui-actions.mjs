import {
  dispatchProgressAction,
  isProgressActionActivation
} from '../../src/ui/action-status.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

const calls = [];
const runtime = {
  pauseOperation(input) {
    calls.push(['pauseOperation', input]);
    return Promise.resolve({ ok: true });
  },
  resumeOperation(input) {
    calls.push(['resumeOperation', input]);
    return Promise.resolve({ ok: true });
  },
  retryStage(input) {
    calls.push(['retryStage', input]);
    return Promise.resolve({ ok: true });
  },
  queueStageReprocess(input) {
    calls.push(['queueStageReprocess', input]);
    return Promise.resolve({ ok: true });
  },
  cancelQueuedStageReprocess(input) {
    calls.push(['cancelQueuedStageReprocess', input]);
    return Promise.resolve({ ok: true });
  }
};

const actionCases = [
  ['stop', 'pauseOperation', { reason: 'user' }],
  ['resume', 'resumeOperation', { operationId: 'run-a' }],
  ['retry', 'retryStage', { operationId: 'run-a', stageId: 'stage-a' }],
  ['reprocess', 'queueStageReprocess', { stageId: 'stage-a' }],
  ['cancel-reprocess', 'cancelQueuedStageReprocess', { stageId: 'stage-a' }]
];

for (const [kind, method, expectedInput] of actionCases) {
  calls.length = 0;
  const result = dispatchProgressAction(runtime, {
    kind,
    operationId: 'run-a',
    stageId: 'stage-a'
  });
  await result;
  assertEqual(calls.length, 1, `${kind} invokes exactly one runtime method`);
  assertDeepEqual(calls[0], [method, expectedInput], `${kind} invokes ${method}`);
}

assert(isProgressActionActivation({ key: 'Enter' }), 'Enter activates a contextual action');
assert(isProgressActionActivation({ key: ' ' }), 'Space activates a contextual action');
assertEqual(isProgressActionActivation({ key: 'Escape' }), false, 'Escape does not activate a contextual action');

calls.length = 0;
await dispatchProgressAction(runtime, {
  kind: 'reprocess',
  operationId: 'stale-run',
  stageId: 'preprocess.arbiter'
});
assertDeepEqual(
  calls[0],
  ['queueStageReprocess', { stageId: 'preprocess.arbiter' }],
  'stale-row Reprocess queues the owning stage'
);

console.log('ui action tests passed');
