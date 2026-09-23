import {
  PROVIDER_CAPABILITY_STATES,
  providerConfigHash,
  resolveProviderCapability,
  sanitizeProviderCapability
} from '../../src/provider-capability.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

function assertThrows(fn, pattern, message) {
  try {
    fn();
  } catch (error) {
    const actual = String(error?.message || error);
    if (!pattern || pattern.test(actual)) return error;
    throw new Error(`${message}: unexpected error ${actual}`);
  }
  throw new Error(message);
}

function provider(lane, {
  profileId = `${lane}-profile`,
  certification = { status: 'not-run' },
  revision = 0
} = {}) {
  const base = {
    lane,
    connectionProfileId: profileId,
    generationPolicy: {
      presetMode: 'isolated',
      instructMode: 'auto',
      samplerMode: 'profile',
      structuredOutputMode: 'auto'
    },
    samplerOverrides: { temperature: lane === 'reasoner' ? 0.4 : 0.1, topP: 0.95 },
    outputTokenCeiling: 8192,
    configRevision: revision,
    certification: { status: 'not-run' }
  };
  if (certification.status !== 'not-run') {
    base.certification = {
      ...certification,
      configHash: providerConfigHash(base),
      checkedAt: '2026-08-06T00:00:00.000Z',
      completionMode: certification.completionMode || 'text',
      structuredOutput: certification.structuredOutput || 'prompt-json',
      checks: certification.checks || { connectivity: 'pass', singleCard: 'pass', fusedCards: 'pass' },
      safeConcurrency: 1,
      diagnosticCodes: [],
      compactError: ''
    };
  }
  return base;
}

function settingsFor({ reasoningLevel = 'medium', utility, reasoner } = {}) {
  return {
    reasoningLevel,
    providers: {
      utility: utility || provider('utility'),
      reasoner: reasoner || provider('reasoner')
    }
  };
}

const host = { connectionProfiles: [{ id: 'utility-profile' }, { id: 'reasoner-profile' }] };
assertDeepEqual(PROVIDER_CAPABILITY_STATES, [
  'unconfigured',
  'uncertified',
  'segmented-ready',
  'fused-ready',
  'unhealthy'
], 'capability states are stable');

for (const lane of ['utility', 'reasoner']) {
  const unconfigured = resolveProviderCapability({
    settings: settingsFor({ [lane]: provider(lane, { profileId: '' }) }),
    lane,
    operation: 'prompt-packet',
    host
  });
  assertEqual(unconfigured.state, 'unconfigured', `${lane} missing profile is unconfigured`);
  assertEqual(unconfigured.testable, false, `${lane} missing profile is not testable`);

  const uncertified = resolveProviderCapability({ settings: settingsFor(), lane, operation: 'prompt-packet', host });
  assertEqual(uncertified.state, 'uncertified', `${lane} selected profile is uncertified`);
  assertEqual(uncertified.segmentedEligible, true, `${lane} uncertified profile may use conservative Segmented`);
  assertEqual(uncertified.fusedEligible, true, `${lane} uncertified profile may use Fused`);

  const segmented = resolveProviderCapability({
    settings: settingsFor({
      [lane]: provider(lane, {
        certification: {
          status: 'partial',
          checks: { connectivity: 'pass', singleCard: 'pass', fusedCards: 'fail' }
        }
      })
    }),
    lane,
    operation: 'prompt-packet',
    host
  });
  assertEqual(segmented.state, 'segmented-ready', `${lane} single-card pass is Segmented-ready`);
  assertEqual(segmented.ready, true, `${lane} Segmented-ready is ready`);
  assertEqual(segmented.fusedEligible, true, `${lane} failed Fused check does not gate Fused`);

  const fused = resolveProviderCapability({
    settings: settingsFor({ [lane]: provider(lane, { certification: { status: 'pass' } }) }),
    lane,
    operation: 'prompt-packet',
    host
  });
  assertEqual(fused.state, 'fused-ready', `${lane} complete certification is Fused-ready`);
  assertEqual(fused.segmentedEligible, true, `${lane} Fused-ready remains Segmented-eligible`);
  assertEqual(fused.fusedEligible, true, `${lane} Fused-ready is Fused-eligible`);
  assertEqual(fused.completionMode, 'text', `${lane} completion mode is exposed`);
  assertEqual(fused.structuredOutput, 'prompt-json', `${lane} structured method is exposed`);
  assertEqual(fused.safeConcurrency, 1, `${lane} safe concurrency is one`);

  const unhealthy = resolveProviderCapability({
    settings: settingsFor({
      [lane]: provider(lane, {
        certification: {
          status: 'fail',
          checks: { connectivity: 'pass', singleCard: 'fail', fusedCards: 'not-run' }
        }
      })
    }),
    lane,
    operation: 'prompt-packet',
    host
  });
  assertEqual(unhealthy.state, 'unhealthy', `${lane} failed single-card check is unhealthy`);
  assertEqual(unhealthy.segmentedEligible, false, `${lane} unhealthy profile cannot route model work`);
}

const unavailable = resolveProviderCapability({
  settings: settingsFor(),
  lane: 'reasoner',
  operation: 'redirect',
  host: { connectionProfiles: [{ id: 'different-profile' }] }
});
assertEqual(unavailable.reasonCode, 'provider-profile-unavailable', 'unavailable saved profile is explicit');
assertEqual(unavailable.eligible, false, 'unavailable profile cannot route');

for (const reasoningLevel of ['low', 'medium', 'high', 'ultra']) {
  const readySettings = settingsFor({
    reasoningLevel,
    utility: provider('utility', { certification: { status: 'pass' } }),
    reasoner: provider('reasoner', { certification: { status: 'pass' } })
  });
  const reasonerRedirect = resolveProviderCapability({
    settings: readySettings,
    lane: 'reasoner',
    operation: 'redirect',
    host
  });
  assertEqual(reasonerRedirect.required, reasoningLevel !== 'low', `${reasoningLevel} Redirect requirement`);
  assertEqual(reasonerRedirect.selectedByPolicy, reasoningLevel !== 'low', `${reasoningLevel} Redirect reasoner selection`);

  const postLane = reasoningLevel === 'high' || reasoningLevel === 'ultra' ? 'reasoner' : 'utility';
  for (const lane of ['utility', 'reasoner']) {
    const post = resolveProviderCapability({ settings: readySettings, lane, operation: 'post-process', host });
    assertEqual(post.selectedByPolicy, lane === postLane, `${reasoningLevel} post-process selects ${postLane}`);
    assertEqual(post.required, lane === postLane, `${reasoningLevel} post-process requires ${postLane}`);
  }
}

const base = provider('utility');
for (const [field, mutate] of [
  ['lane', (value) => ({ ...value, lane: 'reasoner' })],
  ['profile', (value) => ({ ...value, connectionProfileId: 'changed-profile' })],
  ['preset mode', (value) => ({ ...value, generationPolicy: { ...value.generationPolicy, presetMode: 'full-profile' } })],
  ['instruct mode', (value) => ({ ...value, generationPolicy: { ...value.generationPolicy, instructMode: 'off' } })],
  ['sampler mode', (value) => ({ ...value, generationPolicy: { ...value.generationPolicy, samplerMode: 'recursion' } })],
  ['structured mode', (value) => ({ ...value, generationPolicy: { ...value.generationPolicy, structuredOutputMode: 'prompt-json' } })],
  ['temperature', (value) => ({ ...value, samplerOverrides: { ...value.samplerOverrides, temperature: 0.8 } })],
  ['top-p', (value) => ({ ...value, samplerOverrides: { ...value.samplerOverrides, topP: 0.8 } })],
  ['output ceiling', (value) => ({ ...value, outputTokenCeiling: 4096 })],
  ['revision', (value) => ({ ...value, configRevision: 1 })]
]) {
  assert(providerConfigHash(mutate(base)) !== providerConfigHash(base), `${field} participates in provider hash`);
}
assertEqual(
  providerConfigHash({ ...base, secret: 'must-not-matter', endpoint: 'http://localhost:5001' }),
  providerConfigHash(base),
  'unknown and secret-bearing fields do not participate in provider hash'
);

assertThrows(
  () => resolveProviderCapability({ settings: settingsFor(), lane: 'reasonre', operation: 'redirect', host }),
  /Invalid provider lane/,
  'unsupported lane fails closed'
);
assertThrows(
  () => resolveProviderCapability({ settings: settingsFor(), lane: 'reasoner', operation: 'rediret', host }),
  /Invalid provider operation/,
  'unsupported operation fails closed'
);

const sanitized = sanitizeProviderCapability({
  ...resolveProviderCapability({
    settings: settingsFor({ utility: provider('utility', { certification: { status: 'pass' } }) }),
    lane: 'utility',
    operation: 'prompt-packet',
    host
  }),
  secret: 'must-not-survive',
  message: 'Bearer sk-message-secret'
});
assertDeepEqual(Object.keys(sanitized).sort(), [
  'completionMode',
  'configHash',
  'configRevision',
  'configured',
  'eligible',
  'fusedEligible',
  'lane',
  'message',
  'ready',
  'reasonCode',
  'required',
  'safeConcurrency',
  'segmentedEligible',
  'selectedByPolicy',
  'state',
  'structuredOutput',
  'testable'
].sort(), 'sanitized capability exposes only bounded fields');
assert(!JSON.stringify(sanitized).includes('must-not-survive'), 'sanitized capability excludes unknown fields');
assert(!JSON.stringify(sanitized).includes('sk-message-secret'), 'sanitized capability rebuilds safe messages');
assert(Object.isFrozen(sanitized), 'sanitized capability is immutable');

console.log('[pass] provider capability');
