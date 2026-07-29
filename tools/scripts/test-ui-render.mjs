import { progressActionControl } from '../../src/ui/action-status.mjs';
import { readFileSync } from 'node:fs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

const resume = progressActionControl({
  kind: 'resume',
  stageId: 'preprocess.cards.segmented.character',
  operationId: 'run-a',
  label: 'Resume from saved checkpoint',
  icon: 'play'
});

assertDeepEqual(resume, {
  tagName: 'button',
  className: 'recursion-progress-action',
  attrs: {
    type: 'button',
    'aria-label': 'Resume from saved checkpoint',
    title: 'Resume from saved checkpoint'
  },
  dataset: {
    recursionProgressAction: 'resume',
    recursionProgressStageId: 'preprocess.cards.segmented.character',
    recursionProgressOperationId: 'run-a',
    recursionProgressActionIcon: 'play'
  }
}, 'action control exposes one compact accessible button contract');

assertEqual(progressActionControl(null), null, 'non-actionable row keeps an empty reserved slot');

const queued = progressActionControl({
  kind: 'cancel-reprocess',
  stageId: 'preprocess.arbiter',
  operationId: 'run-a',
  label: 'Cancel queued reprocess',
  icon: 'x'
});
assertEqual(queued.dataset.recursionProgressAction, 'cancel-reprocess', 'queued row renders Cancel queued');
assertEqual(Object.keys(queued.dataset).filter((key) => key === 'recursionProgressAction').length, 1, 'row has one primary action');
assert(!Object.values(queued.dataset).some((value) => /expand|menu/i.test(value)), 'action contract has no expander or secondary menu');

const uiSource = readFileSync(new URL('../../src/ui.mjs', import.meta.url), 'utf8');
assert(uiSource.includes('Attempts per step'), 'Advanced UI renders Attempts per step');
assert(
  uiSource.includes('Total automatic model attempts for each Recursion step. Slow calls are not retried unless they fail.'),
  'Attempts setting renders the approved helper'
);
assert(/recursionSettingModelAttemptsPerStep[\s\S]*?min:\s*1[\s\S]*?max:\s*5/.test(uiSource), 'Attempts control is bounded from one to five');
assert(!uiSource.includes('Fresh next generation armed'), 'fresh-next accessible copy does not use armed');
assert(uiSource.includes('Segmented') && uiSource.includes('Fused') && uiSource.includes('Queued'), 'active UI source includes Segmented, Fused, and Queued');

console.log('ui render tests passed');
