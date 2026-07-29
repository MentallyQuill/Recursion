import { readFileSync } from 'node:fs';
import { assert } from '../../tests/helpers/assert.mjs';

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

const activity = read('src/activity.mjs');
assert(activity.includes("'guidance'"), 'activity lane allow-list includes guidance');

const ui = read('src/ui.mjs');
assert(!ui.includes('save and test it'), 'UI copy does not reference removed provider save action');
assert(!ui.includes('catch(() => {})'), 'UI does not silently swallow action failures');
assert(ui.includes("from './ui/view-model.mjs'"), 'UI uses extracted view-model module');
assert(ui.includes("from './ui/provider-panel.mjs'"), 'UI uses extracted provider panel module');

const providers = read('src/providers.mjs');
assert(!/ConnectionManagerRequestService/.test(providers), 'provider core does not inspect SillyTavern ConnectionManager globals');

const runtime = read('src/runtime.mjs');
assert(runtime.includes("from './runtime/run-state.mjs'"), 'runtime uses extracted run-state module');
assert(runtime.includes("from './runtime/diagnostics.mjs'"), 'runtime uses explicit diagnostics builder');
assert(runtime.includes("from './runtime/prompt-install.mjs'"), 'runtime uses extracted prompt install module');
assert(runtime.includes("from './runtime/pipelines/segmented.mjs'"), 'runtime uses extracted Segmented pipeline');
assert(runtime.includes("from './runtime/pipelines/fused.mjs'"), 'runtime uses extracted Fused pipeline');
assert(runtime.includes("from './execution/scheduler.mjs'") || read('src/execution/scheduler.mjs').includes('createExecutionScheduler'), 'scheduler module owns resumable execution');
assert(runtime.includes("from './execution/checkpoints.mjs'") || read('src/execution/checkpoints.mjs').includes('createPipelineRun'), 'checkpoint module owns durable run contracts');

for (const forbidden of [
  'activeRapidWarmRun',
  'warmRapidScene',
  'rapidWarm',
  "pipelineMode === 'rapid'",
  "pipelineMode: 'rapid'"
]) {
  assert(!runtime.includes(forbidden), `runtime excludes retired identifier ${forbidden}`);
}

console.log('[pass] refactor hotspot audit');
