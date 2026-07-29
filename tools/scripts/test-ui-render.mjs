import { progressActionControl } from '../../src/ui/action-status.mjs';
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

console.log('ui render tests passed');
