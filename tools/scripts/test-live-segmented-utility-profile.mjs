import { resolve } from 'node:path';
import { assertDeepEqual, assertEqual, assertRejects } from '../../tests/helpers/assert.mjs';

const module = await import('./prove-live-segmented-utility-profile.mjs');

assertEqual(module.CYDONIA_PROFILE_LABEL, 'nanogpt TheDrummer/Cydonia-24B-v4.3 - Wandlight-1.3', 'runner binds the exact Cydonia profile label');
assertDeepEqual(module.parseSegmentedProfileArgs([
  '--live', '--state', 'artifacts/live-segmented-utility/cydonia.json'
]), {
  live: true,
  statePath: resolve('artifacts/live-segmented-utility/cydonia.json'),
  profileLabel: module.CYDONIA_PROFILE_LABEL
}, 'runner accepts only a bounded live state path');
assertRejects(
  () => Promise.resolve(module.parseSegmentedProfileArgs(['--live', '--state', '../cydonia.json'])),
  /under artifacts\/live-segmented-utility/,
  'runner rejects state outside its artifact root'
);

const stages = [
  { stageId: 'preprocess.arbiter', state: 'completed' },
  { stageId: 'preprocess.cards.segmented.scene-frame', state: 'completed' },
  { stageId: 'preprocess.install', state: 'completed' }
];
assertDeepEqual(module.inspectSegmentedProfileProof({
  certification: { status: 'partial', checks: { connectivity: 'pass', singleCard: 'pass', fusedCards: 'not-run' } },
  requestAudit: { fusedBundleRequests: 0 },
  execution: { state: 'completed', stages },
  before: { userCount: 0, assistantCount: 0 },
  after: { userCount: 1, assistantCount: 1 }
}), { ok: true, errors: [] }, 'Segmented proof accepts one complete host turn without Fused work');
assertEqual(module.inspectSegmentedProfileProof({
  certification: { status: 'pass', checks: { connectivity: 'pass', singleCard: 'pass', fusedCards: 'pass' } },
  requestAudit: { fusedBundleRequests: 1 },
  execution: { state: 'completed', stages: [...stages, { stageId: 'preprocess.cards.fused', state: 'completed' }] },
  before: { userCount: 0, assistantCount: 0 },
  after: { userCount: 1, assistantCount: 1 }
}).ok, false, 'Segmented proof rejects any Fused certification, request, or stage');

console.log('[pass] live Segmented Utility profile runner');
