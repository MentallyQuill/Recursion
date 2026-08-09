import { assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';
import {
  inspectEnduranceLedger,
  inspectLifecycleMilestone,
  qualifyUtilityProfiles,
  sanitizeResilienceReport
} from './lib/live-resilience-matrix-contract.mjs';

const labels = [
  'DeepSeek Flash',
  'MiniMax M3',
  'DeepSeek V4 Pro Cheaper',
  'Gemma 4 31B'
];
const certification = (status = 'pass') => ({
  status,
  checks: {
    connectivity: 'pass',
    singleCard: 'pass',
    fusedCards: status === 'pass' ? 'pass' : 'fail'
  }
});
const profiles = labels.map((label) => ({ label, certification: certification('pass') }));

assertDeepEqual(
  qualifyUtilityProfiles(profiles, 'DeepSeek V4 Pro Cheaper'),
  {
    ok: true,
    assignments: {
      'stop-resume': 'DeepSeek Flash',
      'retry-stage': 'MiniMax M3',
      'fused-fallback': 'DeepSeek V4 Pro Cheaper',
      'queued-reprocess': 'Gemma 4 31B'
    },
    errors: []
  },
  'qualification preserves preferred model order when the preferred Fused profile is ready'
);

const reassigned = qualifyUtilityProfiles([
  profiles[0],
  profiles[1],
  { label: labels[2], certification: certification('partial') },
  profiles[3]
], labels[2]);
assertDeepEqual(reassigned.assignments, {
  'stop-resume': 'DeepSeek V4 Pro Cheaper',
  'retry-stage': 'MiniMax M3',
  'fused-fallback': 'DeepSeek Flash',
  'queued-reprocess': 'Gemma 4 31B'
}, 'first Fused-ready requested profile swaps scenarios with a Segmented-only preferred profile');

assertDeepEqual(
  qualifyUtilityProfiles(profiles.slice(0, 3), labels[2]).errors,
  ['profile-count'],
  'qualification rejects a missing requested profile'
);
assertDeepEqual(
  qualifyUtilityProfiles([profiles[0], profiles[0], profiles[2], profiles[3]], labels[2]).errors,
  ['duplicate-profile-label'],
  'qualification rejects duplicate safe labels'
);
assertDeepEqual(
  qualifyUtilityProfiles(profiles.map((profile) => ({ ...profile, certification: certification('partial') })), labels[2]).errors,
  ['no-fused-ready-profile'],
  'qualification rejects a matrix without a Fused-ready Utility profile'
);

const completed = { operationState: 'completed', adverseStageCount: 0, assistantAfter: true };
assertEqual(inspectLifecycleMilestone('stop-resume', {
  ...completed,
  hostStopCalls: 1,
  promptClears: 1,
  paused: true,
  nativeResumeStarts: 1,
  detachedProviderCalls: 0,
  freshFrontierSignal: true,
  reusedCheckpointCount: 2
}).ok, true, 'Stop/Resume verdict accepts one paused and natively resumed operation');
assertEqual(inspectLifecycleMilestone('stop-resume', {
  ...completed,
  hostStopCalls: 1,
  promptClears: 1,
  paused: true,
  nativeResumeStarts: 1,
  detachedProviderCalls: 1,
  freshFrontierSignal: true
}).ok, false, 'Stop/Resume verdict rejects detached provider work before native Resume callback');

assertEqual(inspectLifecycleMilestone('retry-stage', {
  ...completed,
  failedStageId: 'preprocess.arbiter',
  retryActionVisible: true,
  sameOperation: true,
  attemptBefore: 1,
  attemptAfter: 2,
  upstreamDuplicateCount: 0
}).ok, true, 'Retry Stage verdict accepts same-operation frontier retry');

assertEqual(inspectLifecycleMilestone('fused-fallback', {
  ...completed,
  requestedPipeline: 'fused',
  effectivePipeline: 'fused',
  fusedAttemptCount: 2,
  configuredAttemptLimit: 2,
  fusedDirectiveCompleted: true,
  arbiterCheckpointReused: true,
  segmentedFamilies: ['Scene Frame', 'Open Threads'],
  unresolvedFamilies: ['Scene Frame', 'Open Threads'],
  profileUnavailableRelabel: false
}).ok, true, 'Fused fallback verdict accepts explicit attempt-window exhaustion and unresolved-only Segmented fallback');
assertEqual(inspectLifecycleMilestone('fused-fallback', {
  ...completed,
  requestedPipeline: 'fused',
  effectivePipeline: 'segmented',
  fusedAttemptCount: 0,
  configuredAttemptLimit: 2,
  fusedDirectiveCompleted: false,
  arbiterCheckpointReused: false,
  segmentedFamilies: ['Scene Frame'],
  unresolvedFamilies: ['Scene Frame'],
  profileUnavailableRelabel: true
}).ok, false, 'Fused fallback verdict rejects a preflight downgrade or provider-unavailable relabel');

assertEqual(inspectLifecycleMilestone('queued-reprocess', {
  ...completed,
  queuedStageIds: ['preprocess.cards.segmented.scene-frame'],
  immediateProviderCalls: 0,
  nativeSwipeStarts: 1,
  intentConsumeCount: 1,
  upstreamCheckpointReused: true,
  downstreamRerunCount: 4,
  duplicateOperationCount: 0
}).ok, true, 'queued reprocess verdict accepts one swipe-owned downstream rerun');

const turns = Array.from({ length: 8 }, (_, index) => ({
  turnId: `turn-${index + 1}`,
  profileLabel: labels[index % labels.length],
  chatIdHash: 'chat-hash',
  userCount: index + 1,
  assistantCount: index + 1,
  turnKeyHash: `turn-key-${index + 1}`,
  operationState: 'completed',
  promptKeyCount: 3,
  preparedReuse: false
}));
assertDeepEqual(inspectEnduranceLedger({
  acceptedNewTurns: turns,
  swipeRecords: [{ kind: 'queued-reprocess', countsAsNewTurn: false }],
  queuedReprocess: null,
  pausedOperationCount: 0,
  runningStageCount: 0
}), {
  ok: true,
  errors: [],
  acceptedNewTurns: 8,
  profileCounts: Object.fromEntries(labels.map((label) => [label, 2]))
}, 'endurance ledger accepts eight monotonic turns and one non-counting swipe');
const adaptedLabels = [labels[0], labels[1], labels[0], labels[2], labels[0], labels[1], labels[0], labels[2]];
assertEqual(inspectEnduranceLedger({
  acceptedNewTurns: turns.map((turn, index) => ({ ...turn, profileLabel: adaptedLabels[index] })),
  expectedProfileLabels: adaptedLabels,
  swipeRecords: [],
  queuedReprocess: null,
  pausedOperationCount: 0,
  runningStageCount: 0
}).ok, true, 'endurance ledger accepts the explicit adapted profile rotation after incompatibilities');

assertEqual(inspectEnduranceLedger({
  acceptedNewTurns: turns.map((turn, index) => index === 7 ? { ...turn, chatIdHash: 'other-chat' } : turn),
  swipeRecords: [],
  queuedReprocess: null,
  pausedOperationCount: 0,
  runningStageCount: 0
}).ok, false, 'endurance ledger rejects a changed chat identity');

const sanitized = sanitizeResilienceReport({
  message: 'TRANSCRIPT_SECRET',
  prompt: 'PROMPT_SECRET',
  request: { content: 'REQUEST_SECRET' },
  response: { reasoning: 'REASONING_SECRET' },
  connectionProfileId: 'PROFILE_SECRET',
  'secret-id': 'SECRET_REFERENCE',
  chat: [{ mes: 'CHAT_SECRET' }],
  packet: { guidance: 'PACKET_SECRET' },
  summary: { operationId: 'operation-safe', profileLabel: 'DeepSeek Flash' }
});
assertEqual(JSON.stringify(sanitized).includes('SECRET'), false, 'resilience report sanitizer removes forbidden live content');
assertDeepEqual(sanitized.summary, { operationId: 'operation-safe', profileLabel: 'DeepSeek Flash' }, 'sanitizer preserves bounded identifiers and labels');

console.log('[pass] live resilience matrix contract');
