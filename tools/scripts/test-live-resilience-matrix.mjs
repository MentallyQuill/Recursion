import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertDeepEqual, assertEqual, assertRejects } from '../../tests/helpers/assert.mjs';

const module = await import('./prove-live-resilience-matrix.mjs');
const source = readFileSync(new URL('./prove-live-resilience-matrix.mjs', import.meta.url), 'utf8');

const labels = [
  'nanogpt deepseek/deepseek-v4-flash:thinking - Provider',
  'nanogpt minimax/minimax-m3:thinking - Freaky Frankenstein 5 - Internal States - Fast',
  'nanogpt deepseek/deepseek-v4-pro-cheaper:thinking - Celia V5.4',
  'nanogpt gemma-4-31B-Fabled - RedRising-1.3'
];

assertEqual(module.PROFILE_LABELS.length, 4, 'runner owns exactly four requested Utility profiles');
assertDeepEqual(module.PROFILE_LABELS, labels, 'runner preserves the requested profile order');
assertEqual(typeof module.parseResilienceArgs, 'function', 'runner exports CLI parser');
assertEqual(typeof module.assertResiliencePreflight, 'function', 'runner exports preflight');
assertEqual(typeof module.createResilienceCheckpoint, 'function', 'runner exports checkpoint creator');
assertEqual(typeof module.validateResilienceCheckpoint, 'function', 'runner exports checkpoint validator');
assertEqual(typeof module.runLiveResilienceMatrix, 'function', 'runner exports live entrypoint');
assertEqual(typeof module.clickProgressAction, 'function', 'runner exports exact-label progress action driver');
assertEqual(typeof module.readExecutionSnapshot, 'function', 'runner exports bounded execution evidence reader');
assertEqual(typeof module.driveStopResumeMilestone, 'function', 'runner exports Stop Resume milestone driver');
assertEqual(typeof module.driveRetryStageMilestone, 'function', 'runner exports Retry Stage milestone driver');
assertEqual(typeof module.driveFusedFallbackMilestone, 'function', 'runner exports Fused fallback milestone driver');
assertEqual(typeof module.driveQueuedReprocessMilestone, 'function', 'runner exports queued reprocess milestone driver');
assertEqual(typeof module.clickProgressStageAction, 'function', 'runner exports stage-specific progress action driver');
assertEqual(typeof module.nextResilienceWork, 'function', 'runner exports bounded scheduler');
assertEqual(typeof module.acceptResilienceTurn, 'function', 'runner exports accepted-turn ledger writer');
assertEqual(typeof module.ensureSyntheticChat, 'function', 'runner exports synthetic chat opener');
assertEqual(module.selectSyntheticCharacterIndex([], null), -1, 'chat opener reports no available character');
assertEqual(module.selectSyntheticCharacterIndex([{ name: 'Story' }], null), 0, 'chat opener selects the first soak character');
assertEqual(module.selectSyntheticCharacterIndex([{ name: 'One' }, { name: 'Two' }], 1), 1, 'chat opener preserves a valid active character');
assertDeepEqual(module.validateHostTurnCounts({
  baselineCounts: { user: 1, assistant: 1 },
  acceptedNewTurns: []
}, { userCount: 1, assistantCount: 1 }), { ok: true, errors: [] }, 'resume accepts exact checkpointed host counts');
assertEqual(module.validateHostTurnCounts({
  baselineCounts: { user: 1, assistant: 1 },
  acceptedNewTurns: []
}, { userCount: 2, assistantCount: 2 }).ok, false, 'resume detects an unaccepted completed host turn');
const repairCheckpoint = { status: 'fail', branchSha: 'old', acceptedNewTurns: [], defect: { code: 'failed' } };
assertEqual(module.adoptRepairSha(repairCheckpoint, 'new'), repairCheckpoint, 'repair adoption updates the same checkpoint');
assertEqual(repairCheckpoint.branchSha, 'new', 'repair adoption advances only the checkpoint SHA');
assertRejects(
  () => Promise.resolve(module.adoptRepairSha({ status: 'running', branchSha: 'old' }, 'new')),
  /failed checkpoint/,
  'repair adoption refuses a non-failed checkpoint'
);

const safeState = resolve('artifacts', 'live-resilience-matrix', 'active.json');
assertDeepEqual(module.parseResilienceArgs(['--live', '--state', safeState]), {
  live: true,
  statePath: safeState
}, 'CLI parser accepts a live run and safe JSON checkpoint');
assertRejects(
  () => Promise.resolve(module.parseResilienceArgs(['--state', safeState])),
  /--live/,
  'CLI requires explicit live mutation opt-in'
);
assertRejects(
  () => Promise.resolve(module.parseResilienceArgs(['--live', '--state', resolve('artifacts', 'escape.json')])),
  /live-resilience-matrix/,
  'CLI rejects state paths outside the bounded artifact directory'
);
assertRejects(
  () => Promise.resolve(module.parseResilienceArgs(['--live', '--state', resolve('artifacts', 'live-resilience-matrix', 'active.txt')])),
  /\.json/,
  'CLI requires JSON checkpoint paths'
);
assertRejects(
  () => Promise.resolve(module.assertResiliencePreflight({ user: 'default-user', baseUrl: 'http://localhost:8000' })),
  /recursion-soak/,
  'preflight rejects non-soak users'
);

const checkpoint = module.createResilienceCheckpoint({
  runId: 'resilience-safe-run',
  user: 'recursion-soak-a',
  branchSha: 'abc123',
  profileLabels: labels,
  chatIdHash: 'chat-hash'
});
assertEqual(checkpoint.schema, 'recursion.liveResilienceMatrix.v1', 'checkpoint uses versioned schema');
assertEqual(checkpoint.status, 'qualifying', 'new checkpoint starts qualification');
assertDeepEqual(checkpoint.acceptedNewTurns, [], 'new checkpoint has no accepted turns');
assertDeepEqual(checkpoint.swipeRecords, [], 'new checkpoint has no swipe records');
assertDeepEqual(module.validateResilienceCheckpoint(checkpoint, {
  user: 'recursion-soak-a',
  branchSha: 'abc123',
  profileLabels: labels,
  chatIdHash: 'chat-hash'
}), { ok: true, errors: [] }, 'matching checkpoint may resume');
assertEqual(module.validateResilienceCheckpoint(checkpoint, {
  user: 'recursion-soak-a',
  branchSha: 'different',
  profileLabels: labels,
  chatIdHash: 'chat-hash'
}).ok, false, 'changed branch SHA refuses resume');
assertEqual(module.validateResilienceCheckpoint(checkpoint, {
  user: 'recursion-soak-a',
  branchSha: 'abc123',
  profileLabels: [...labels].reverse(),
  chatIdHash: 'chat-hash'
}).ok, false, 'changed profile ordering refuses resume');
assertEqual(module.validateResilienceCheckpoint(checkpoint, {
  user: 'recursion-soak-a',
  branchSha: 'abc123',
  profileLabels: labels,
  chatIdHash: 'other-chat'
}).ok, false, 'changed chat identity refuses resume');

checkpoint.assignments = {
  'stop-resume': labels[0],
  'retry-stage': labels[1],
  'fused-fallback': labels[2],
  'queued-reprocess': labels[3]
};
checkpoint.status = 'ready';
assertDeepEqual(module.nextResilienceWork(checkpoint), {
  kind: 'milestone',
  milestone: 'stop-resume',
  profileLabel: labels[0]
}, 'scheduler starts with Stop Resume');
for (const milestone of ['stop-resume', 'retry-stage', 'fused-fallback', 'queued-reprocess']) {
  checkpoint.milestones[milestone] = { ok: true };
  checkpoint.acceptedNewTurns.push({ profileLabel: checkpoint.assignments[milestone] });
}
assertDeepEqual(module.nextResilienceWork(checkpoint), {
  kind: 'endurance',
  index: 0,
  profileLabel: labels[0]
}, 'scheduler rotates into the first endurance profile after four resilience turns');
checkpoint.acceptedNewTurns.push({ profileLabel: labels[0] });
assertDeepEqual(module.nextResilienceWork(checkpoint), {
  kind: 'endurance',
  index: 1,
  profileLabel: labels[1]
}, 'scheduler rotates Utility profile order without a ninth turn');
while (checkpoint.acceptedNewTurns.length < 8) checkpoint.acceptedNewTurns.push({ profileLabel: labels[checkpoint.acceptedNewTurns.length - 4] });
assertDeepEqual(module.nextResilienceWork(checkpoint), { kind: 'complete' }, 'scheduler stops exactly at eight accepted new turns');

const ledgerCheckpoint = module.createResilienceCheckpoint({
  runId: 'ledger-run',
  user: 'recursion-soak-a',
  branchSha: 'abc123',
  profileLabels: labels,
  chatIdHash: 'chat-hash',
  baselineCounts: { user: 6, assistant: 6 }
});
module.acceptResilienceTurn(ledgerCheckpoint, {
  profileLabel: labels[0],
  execution: { operationId: 'operation-one', turnKeyHash: 'turn-hash', state: 'completed' },
  sendResult: { after: { userCount: 7, assistantCount: 7 } },
  promptKeyCount: 3,
  preparedReuse: false
});
assertDeepEqual(ledgerCheckpoint.acceptedNewTurns[0], {
  turnId: 'operation-one',
  turnKeyHash: 'turn-hash',
  chatIdHash: 'chat-hash',
  profileLabel: labels[0],
  userCount: 1,
  assistantCount: 1,
  operationState: 'completed',
  promptKeyCount: 3,
  preparedReuse: false
}, 'accepted turn stores only soak-relative counts and bounded identifiers');
assertRejects(
  () => Promise.resolve(module.acceptResilienceTurn(ledgerCheckpoint, {
    profileLabel: labels[1],
    execution: { operationId: 'operation-two', turnKeyHash: 'turn-two', state: 'completed' },
    sendResult: { after: { userCount: 9, assistantCount: 8 } },
    promptKeyCount: 3,
    preparedReuse: false
  })),
  /monotonic/,
  'ledger rejects skipped or non-monotonic message counts'
);

assertEqual(/post[- ]?process/i.test(source), false, 'runner does not invoke or import Post-process');
assertEqual(/\.screenshot\s*\(|tracing\./.test(source), false, 'runner cannot create screenshots or traces');
assertEqual(/connectionProfileId\s*:\s*[^'"\[]/.test(source), false, 'runner does not persist profile ids');

const actionCalls = [];
const fakeAction = {
  async waitFor(options) { actionCalls.push(['waitFor', options]); },
  async evaluate() { return { kind: 'resume', operationId: 'operation-safe', stageId: 'preprocess.arbiter' }; },
  async click(options) { actionCalls.push(['click', options]); }
};
const fakePage = {
  locator(selector) {
    actionCalls.push(['locator', selector]);
    return { first: () => ({ click: async (options) => actionCalls.push(['open', options]) }) };
  },
  getByRole(role, options) {
    actionCalls.push(['getByRole', role, options]);
    return { first: () => fakeAction };
  }
};
assertDeepEqual(await module.clickProgressAction(fakePage, 'Resume from saved checkpoint', 4321), {
  kind: 'resume',
  operationId: 'operation-safe',
  stageId: 'preprocess.arbiter'
}, 'progress action returns bounded dataset evidence');
assertDeepEqual(actionCalls.find((call) => call[0] === 'getByRole'), [
  'getByRole',
  'button',
  { name: 'Resume from saved checkpoint', exact: true }
], 'progress driver requires the exact accessible label');
assertEqual(actionCalls.filter((call) => call[0] === 'click').length, 1, 'progress driver clicks exactly once');

const invalidJsonBody = module.substituteInvalidModelResponse(
  JSON.stringify({ choices: [{ message: { content: '{"schema":"recursion.utilityArbiter.v1"}' } }] }),
  'application/json'
);
assertEqual(JSON.parse(invalidJsonBody).choices[0].message.content, '{invalid', 'JSON response substitution preserves envelope but corrupts model content');
const invalidSseBody = module.substituteInvalidModelResponse(
  'data: {"choices":[{"delta":{"content":"valid"}}]}\n\ndata: [DONE]\n\n',
  'text/event-stream'
);
assertEqual(invalidSseBody.includes('{invalid'), true, 'stream substitution emits bounded invalid model content');
assertEqual(invalidSseBody.includes('[DONE]'), true, 'stream substitution remains terminal');
const zeroUsefulBody = module.substituteModelResponseContent(
  JSON.stringify({ choices: [{ message: { content: '{"items":[{"family":"bad"}]}' } }] }),
  'application/json',
  '{"items":[]}'
);
assertEqual(JSON.parse(zeroUsefulBody).choices[0].message.content, '{"items":[]}', 'Fused fault preserves a valid zero-useful bundle payload');

console.log('[pass] live resilience matrix runner');
