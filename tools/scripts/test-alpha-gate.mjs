import { existsSync, readFileSync } from 'node:fs';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

const source = readFileSync(new URL('./run-alpha-gate.mjs', import.meta.url), 'utf8');
const testRunnerSource = readFileSync(new URL('./run-tests.mjs', import.meta.url), 'utf8');
const providerParserTest = readFileSync(new URL('./test-provider-response-parser.mjs', import.meta.url), 'utf8');
const providerBatchTest = readFileSync(new URL('./test-providers.mjs', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const manifestJson = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));
const storageSource = readFileSync(new URL('../../src/storage.mjs', import.meta.url), 'utf8');
const documentationIndex = readFileSync(new URL('../../docs/DOCUMENTATION_INDEX.md', import.meta.url), 'utf8');
const releaseIndex = readFileSync(new URL('../../docs/release/README.md', import.meta.url), 'utf8');
const releaseNoteUrl = new URL('../../docs/release/0.2.0-alpha.2.md', import.meta.url);
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

const DIRECT_SETUP_ACTION_RE = /\b(?:add|configure|enter|fill|paste|provide|save|set|specify|supply|use)\b/i;
const DIRECT_CREDENTIAL_RE = /\b(?:api[- ]?key|access[- ]?token|bearer\s+token|secret(?:s)?|credential(?:s)?)\b/i;
const DIRECT_ENDPOINT_RE = /\b(?:base\s*url|api\s*url|endpoint|server\s+url|direct\s+(?:api\s+)?connection)\b/i;
const NON_NORMATIVE_RE = /^\s*(?:historical|legacy|deprecated|archived|archive|non[- ]normative|older\s+versions?)\b/i;
const NEGATED_GUIDANCE_RE = /\b(?:do\s+not|don't|never|not|without|no|does\s+not|must\s+not|cannot|can't|excluded|omit(?:s)?|prohibited|owned\s+by|remain\s+owned)\b/i;

function hasNormativeDirectProviderGuidance(text) {
  return String(text || '').split(/\r?\n/).some((rawLine) => {
    const line = rawLine.trim();
    if (!line || NON_NORMATIVE_RE.test(line)) return false;
    return line
      .split(/(?:[,;:.!?]\s+|\s+\b(?:and|but|then|however|instead|while|although|unless)\b\s+)/i)
      .some((clause) => {
        const normalizedClause = clause.trim();
        if (!normalizedClause || NEGATED_GUIDANCE_RE.test(normalizedClause)) return false;
        if (!DIRECT_SETUP_ACTION_RE.test(normalizedClause)) return false;
        return DIRECT_CREDENTIAL_RE.test(normalizedClause) || DIRECT_ENDPOINT_RE.test(normalizedClause);
      });
  });
}

const directProviderGuidanceFixtures = [
  ['Configure an API key and base URL directly in Recursion.', true],
  ['Paste your bearer token into the direct endpoint field, then save.', true],
  ['If a Connection Profile is not available, configure an API key and base URL directly in Recursion.', true],
  ['SillyTavern owns endpoint configuration and credentials; Recursion has no endpoint input.', false],
  ['Do not enter API keys here; Connection Profiles own credentials.', false],
  ['Historical note: older versions accepted direct API keys.', false]
];
for (const [fixture, expected] of directProviderGuidanceFixtures) {
  assertEqual(
    hasNormativeDirectProviderGuidance(fixture),
    expected,
    `direct provider guidance fixture ${expected ? 'is rejected' : 'is allowed'}`
  );
}
assertEqual(hasNormativeDirectProviderGuidance(activeDocs), false, 'current normative docs do not prescribe direct provider credentials or endpoints');

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
assertEqual(packageJson.version, '0.2.0-alpha.2', 'package version is alpha.2');
assertEqual(manifestJson.version, '0.2.0-alpha.2', 'manifest version is alpha.2');
assert(/RECURSION_VERSION\s*=\s*['"]0\.2\.0-alpha\.2['"]/.test(storageSource), 'storage records alpha.2 runtime version');
assert(existsSync(releaseNoteUrl), 'alpha.2 release note exists');
assert(releaseIndex.includes('[0.2.0-alpha.2](0.2.0-alpha.2.md)'), 'release index names alpha.2');
assert(documentationIndex.includes('release/0.2.0-alpha.2.md'), 'documentation index names alpha.2');
assert(!currentDocs.includes('OpenAI-compatible direct keys'), 'normative docs do not prescribe direct API keys');
assert(/test-\.\*\\\.mjs/.test(testRunnerSource), 'offline runner discovers registered regression scripts');
assert(providerParserTest.includes('Claude tool input'), 'Claude tool-input regression coverage is registered');
assert(providerBatchTest.includes('mixed provider batch isolates one rejected slot'), 'per-slot batch isolation coverage is registered');

console.log('[pass] alpha gate');
