import { createRecursionViewModel } from '../../src/ui/view-model.mjs';
import { assertEqual } from '../../tests/helpers/assert.mjs';

assertEqual(
  createRecursionViewModel({
    settings: { pipelineMode: 'segmented' }
  }).pipelineLabel,
  'Segmented',
  'view model exposes the canonical Segmented label'
);

assertEqual(
  createRecursionViewModel({
    settings: { pipelineMode: 'rapid' }
  }).pipelineMode,
  'segmented',
  'view model sends removed modes through the generic fallback'
);

console.log('ui view-model tests passed');
