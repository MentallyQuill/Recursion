import { readFileSync } from 'node:fs';
import { assert } from '../../tests/helpers/assert.mjs';

const source = readFileSync(new URL('./run-alpha-gate.mjs', import.meta.url), 'utf8');
const currentDocPaths = [
  '../../README.md',
  '../../DESIGN.md',
  '../../src/README.md',
  '../../docs/RECURSION_EXTENSION_SPEC.md',
  '../../docs/architecture/CACHE_USE_AND_REUSE_SPEC.md',
  '../../docs/architecture/POST_PROCESS_CARDS_RUNTIME.md',
  '../../docs/architecture/PROVIDER_AND_GENERATION_SPEC.md',
  '../../docs/architecture/RUNTIME_ARCHITECTURE.md',
  '../../docs/architecture/STORAGE_AND_DIAGNOSTICS.md',
  '../../docs/design/BEHAVIOR_SETTINGS_POLICY_SPEC.md',
  '../../docs/design/UI_SPEC.md',
  '../../docs/technical/HOST_INTEGRATION_MANUAL.md',
  '../../docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md',
  '../../docs/technical/RECURSION_COST_RESEARCH.md',
  '../../docs/technical/RECURSION_TECHNICAL_MANUAL.md',
  '../../docs/technical/RUNTIME_TURN_SEQUENCE.md',
  '../../docs/technical/STORAGE_AND_DIAGNOSTICS.md',
  '../../docs/testing/LIVE_SMOKE_TEST_PLAN.md',
  '../../docs/testing/TESTING_STRATEGY.md',
  '../../docs/user/PROVIDER_SETUP.md',
  '../../docs/user/RECURSION_OPERATOR_MANUAL.md'
];
const currentDocs = currentDocPaths
  .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
  .join('\n');
const activeDocs = currentDocs;

assert(/run-tests\.mjs/.test(source), 'alpha gate runs deterministic test suite');
assert(/current documentation contract/.test(source), 'alpha gate reports the current documentation audit');
assert(/runPlaywrightReadiness/.test(source), 'alpha gate runs offline Playwright readiness');
assert(/readiness\.status\s*!==\s*'pass'/.test(source), 'alpha gate fails closed when Playwright readiness fails');
assert(/process\.exitCode\s*=\s*1/.test(source), 'alpha gate sets nonzero exit on readiness failure');
assert(/recursion alpha gate/.test(source), 'alpha gate prints stable pass marker');
assert(currentDocs.includes('Segmented'), 'current documentation names the Segmented pipeline');
assert(currentDocs.includes('Fused'), 'current documentation names the Fused pipeline');
assert(currentDocs.includes('Attempts per step'), 'current documentation explains the attempt setting');
assert(currentDocs.includes('Queued'), 'current documentation explains queued execution controls');
assert(!activeDocs.includes('Rapid pipeline'), 'current documentation retires the Rapid pipeline');
assert(!activeDocs.includes('Standard pipeline'), 'current documentation retires the Standard pipeline');
assert(
  /"pipelineMode"\s*:\s*"segmented"[\s\S]{0,120}"modelAttemptsPerStep"\s*:\s*2/.test(currentDocs),
  'current documentation includes the canonical pipeline and attempt settings example'
);

console.log('[pass] alpha gate');
