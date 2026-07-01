import { readFileSync } from 'node:fs';
import { assert } from '../../tests/helpers/assert.mjs';

const source = readFileSync(new URL('./run-alpha-gate.mjs', import.meta.url), 'utf8');

assert(/run-tests\.mjs/.test(source), 'alpha gate runs deterministic test suite');
assert(/runPlaywrightReadiness/.test(source), 'alpha gate runs offline Playwright readiness');
assert(/readiness\.status\s*!==\s*'pass'/.test(source), 'alpha gate fails closed when Playwright readiness fails');
assert(/process\.exitCode\s*=\s*1/.test(source), 'alpha gate sets nonzero exit on readiness failure');
assert(/recursion alpha gate/.test(source), 'alpha gate prints stable pass marker');

console.log('[pass] alpha gate');
