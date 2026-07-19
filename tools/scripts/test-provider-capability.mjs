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
    if (!pattern || pattern.test(actual)) return;
    throw new Error(`${message}: unexpected error ${actual}`);
  }
  throw new Error(message);
}

function configuredProvider(lane, health = { status: 'not-run' }) {
  const provider = {
    lane,
    source: 'host-connection-profile',
    hostConnectionProfileId: `${lane}-profile`,
    openAICompatible: {
      baseUrl: '',
      model: '',
      sessionApiKeyPresent: false
    },
    temperature: lane === 'reasoner' ? 0.4 : 0.1,
    topP: 0.95,
    maxTokens: 8192,
    configRevision: 3
  };
  return {
    ...provider,
    health: {
      ...health,
      ...(health.status === 'pass' || health.status === 'fail'
        ? { configHash: providerConfigHash(provider) }
        : {})
    }
  };
}

function settingsFor({
  reasoningLevel = 'medium',
  utility = configuredProvider('utility'),
  reasoner = configuredProvider('reasoner')
} = {}) {
  return {
    reasoningLevel,
    providers: { utility, reasoner }
  };
}

const host = {
  currentModelAvailable: true,
  connectionProfiles: [
    { id: 'utility-profile' },
    { id: 'reasoner-profile' }
  ]
};

assertDeepEqual(
  PROVIDER_CAPABILITY_STATES,
  ['unconfigured', 'untested', 'ready', 'unhealthy'],
  'capability states are stable'
);

for (const lane of ['utility', 'reasoner']) {
  const unconfigured = resolveProviderCapability({
    settings: settingsFor({
      [lane]: {
        ...configuredProvider(lane),
        hostConnectionProfileId: ''
      }
    }),
    lane,
    operation: 'prompt-packet',
    host
  });
  assertEqual(unconfigured.state, 'unconfigured', `${lane} missing route is unconfigured`);
  assertEqual(unconfigured.configured, false, `${lane} missing route is not configured`);
  assertEqual(unconfigured.testable, false, `${lane} missing route is not testable`);

  const untested = resolveProviderCapability({
    settings: settingsFor({ [lane]: configuredProvider(lane) }),
    lane,
    operation: 'prompt-packet',
    host
  });
  assertEqual(untested.state, 'untested', `${lane} without bound health is untested`);
  assertEqual(untested.testable, true, `${lane} complete route is testable`);

  const ready = resolveProviderCapability({
    settings: settingsFor({
      [lane]: configuredProvider(lane, { status: 'pass' })
    }),
    lane,
    operation: 'prompt-packet',
    host
  });
  assertEqual(ready.state, 'ready', `${lane} matching pass is ready`);
  assertEqual(ready.ready, true, `${lane} matching pass exposes ready`);

  const unhealthy = resolveProviderCapability({
    settings: settingsFor({
      [lane]: configuredProvider(lane, { status: 'fail', compactError: 'unsafe provider detail' })
    }),
    lane,
    operation: 'prompt-packet',
    host
  });
  assertEqual(unhealthy.state, 'unhealthy', `${lane} matching failure is unhealthy`);
  assert(!unhealthy.message.includes('unsafe provider detail'), `${lane} capability message excludes provider error detail`);

  const staleHealthProvider = configuredProvider(lane, { status: 'pass' });
  staleHealthProvider.maxTokens = 4096;
  const staleHealth = resolveProviderCapability({
    settings: settingsFor({ [lane]: staleHealthProvider }),
    lane,
    operation: 'prompt-packet',
    host
  });
  assertEqual(staleHealth.state, 'untested', `${lane} stale health hash becomes untested`);
}

for (const reasoningLevel of ['low', 'medium', 'high', 'ultra']) {
  for (const operation of ['prompt-packet', 'provider-test', 'redirect']) {
    const readyReasoner = resolveProviderCapability({
      settings: settingsFor({
        reasoningLevel,
        reasoner: configuredProvider('reasoner', { status: 'pass' })
      }),
      lane: 'reasoner',
      operation,
      host
    });
    const required = operation === 'redirect' && reasoningLevel !== 'low';
    assertEqual(readyReasoner.required, required, `${reasoningLevel} ${operation} required policy`);
    assertEqual(
      readyReasoner.selectedByPolicy,
      reasoningLevel !== 'low',
      `${reasoningLevel} ${operation} selection policy`
    );
    assertEqual(
      readyReasoner.eligible,
      operation === 'provider-test' ? true : reasoningLevel !== 'low',
      `${reasoningLevel} ${operation} ready eligibility`
    );
  }
}

for (const lane of ['utility', 'reasoner']) {
  for (const reasoningLevel of ['low', 'medium', 'high', 'ultra']) {
    for (const operation of ['prompt-packet', 'provider-test', 'redirect']) {
      for (const state of ['unconfigured', 'untested', 'ready', 'unhealthy']) {
        const health = state === 'ready'
          ? { status: 'pass' }
          : state === 'unhealthy'
            ? { status: 'fail' }
            : { status: 'not-run' };
        const base = configuredProvider(lane, health);
        const provider = state === 'unconfigured'
          ? { ...base, hostConnectionProfileId: '' }
          : base;
        const capability = resolveProviderCapability({
          settings: settingsFor({ reasoningLevel, [lane]: provider }),
          lane,
          operation,
          host
        });
        const testable = state !== 'unconfigured';
        const selected = lane === 'utility' || reasoningLevel !== 'low';
        assertEqual(capability.state, state, `${lane} ${reasoningLevel} ${operation} ${state} matrix state`);
        assertEqual(
          capability.eligible,
          operation === 'provider-test' ? testable : selected && state === 'ready',
          `${lane} ${reasoningLevel} ${operation} ${state} matrix eligibility`
        );
      }
    }
  }
}

for (const reasoningLevel of ['medium', 'high', 'ultra']) {
  for (const state of ['unconfigured', 'untested', 'unhealthy']) {
    const base = configuredProvider('reasoner', state === 'unhealthy' ? { status: 'fail' } : { status: 'not-run' });
    const reasoner = state === 'unconfigured'
      ? { ...base, hostConnectionProfileId: '' }
      : base;
    const ordinary = resolveProviderCapability({
      settings: settingsFor({ reasoningLevel, reasoner }),
      lane: 'reasoner',
      operation: 'prompt-packet',
      host
    });
    assertEqual(ordinary.state, state, `${reasoningLevel} ordinary ${state} state`);
    assertEqual(ordinary.required, false, `${reasoningLevel} ordinary work does not require Reasoner`);
    assertEqual(ordinary.eligible, false, `${reasoningLevel} ordinary ${state} falls back`);

    const redirect = resolveProviderCapability({
      settings: settingsFor({ reasoningLevel, reasoner }),
      lane: 'reasoner',
      operation: 'redirect',
      host
    });
    assertEqual(redirect.required, true, `${reasoningLevel} Redirect requires Reasoner`);
    assertEqual(redirect.eligible, false, `${reasoningLevel} Redirect blocks for ${state}`);
  }
}

const lowRedirectReasoner = resolveProviderCapability({
  settings: settingsFor({
    reasoningLevel: 'low',
    reasoner: configuredProvider('reasoner', { status: 'fail' })
  }),
  lane: 'reasoner',
  operation: 'redirect',
  host
});
const lowRedirectUtility = resolveProviderCapability({
  settings: settingsFor({
    reasoningLevel: 'low',
    utility: configuredProvider('utility', { status: 'pass' })
  }),
  lane: 'utility',
  operation: 'redirect',
  host
});
assertEqual(lowRedirectReasoner.selectedByPolicy, false, 'Low Redirect does not select Reasoner');
assertEqual(lowRedirectReasoner.required, false, 'Low Redirect does not require Reasoner');
assertEqual(lowRedirectUtility.eligible, true, 'Low Redirect selects ready Utility');

for (const reasoningLevel of ['low', 'medium', 'high', 'ultra']) {
  const expectedLane = reasoningLevel === 'high' || reasoningLevel === 'ultra'
    ? 'reasoner'
    : 'utility';
  for (const lane of ['utility', 'reasoner']) {
    const capability = resolveProviderCapability({
      settings: settingsFor({
        reasoningLevel,
        [lane]: configuredProvider(lane, { status: 'pass' })
      }),
      lane,
      operation: 'post-process',
      host
    });
    assertEqual(
      capability.selectedByPolicy,
      lane === expectedLane,
      `${reasoningLevel} post-process selects only ${expectedLane}`
    );
    assertEqual(
      capability.required,
      lane === expectedLane,
      `${reasoningLevel} post-process requires only ${expectedLane}`
    );
    assertEqual(
      capability.eligible,
      lane === expectedLane,
      `${reasoningLevel} post-process forbids provider-lane substitution`
    );
  }
}

const unavailableHighPostProcess = resolveProviderCapability({
  settings: settingsFor({
    reasoningLevel: 'high',
    reasoner: configuredProvider('reasoner', { status: 'fail' }),
    utility: configuredProvider('utility', { status: 'pass' })
  }),
  lane: 'reasoner',
  operation: 'post-process',
  host
});
assertEqual(unavailableHighPostProcess.required, true, 'High post-process still requires Reasoner when unhealthy');
assertEqual(unavailableHighPostProcess.eligible, false, 'High post-process does not fall back to healthy Utility');

const directProvider = {
  lane: 'reasoner',
  source: 'openai-compatible',
  hostConnectionProfileId: '',
  openAICompatible: {
    baseUrl: 'https://example.invalid/v1',
    model: 'reasoner-model',
    sessionApiKeyPresent: true
  },
  temperature: 0.4,
  topP: 0.95,
  maxTokens: 8192,
  configRevision: 7,
  health: { status: 'not-run' }
};
const directTest = resolveProviderCapability({
  settings: settingsFor({ reasoner: directProvider }),
  lane: 'reasoner',
  operation: 'provider-test',
  host
});
assertEqual(directTest.testable, true, 'complete direct provider is testable');
assertEqual(directTest.eligible, true, 'provider test eligibility does not require prior health');

const missingKey = resolveProviderCapability({
  settings: settingsFor({
    reasoner: {
      ...directProvider,
      openAICompatible: {
        ...directProvider.openAICompatible,
        sessionApiKeyPresent: false
      }
    }
  }),
  lane: 'reasoner',
  operation: 'provider-test',
  host
});
assertEqual(missingKey.state, 'unconfigured', 'direct provider without key is unconfigured');
assertEqual(missingKey.testable, false, 'direct provider without key is not testable');
assertEqual(missingKey.reasonCode, 'provider-session-key-missing', 'missing key has a safe reason code');

const unavailableCurrentModel = resolveProviderCapability({
  settings: settingsFor({
    utility: {
      ...configuredProvider('utility'),
      source: 'host-current-model'
    }
  }),
  lane: 'utility',
  operation: 'provider-test',
  host: { currentModelAvailable: false }
});
assertEqual(unavailableCurrentModel.reasonCode, 'provider-current-model-unavailable', 'unavailable current model is explicit');
assertEqual(unavailableCurrentModel.testable, false, 'unavailable current model is not testable');

const unavailableProfile = resolveProviderCapability({
  settings: settingsFor(),
  lane: 'reasoner',
  operation: 'redirect',
  host: { connectionProfiles: [{ id: 'different-profile' }] }
});
assertEqual(unavailableProfile.reasonCode, 'provider-profile-unavailable', 'unavailable saved profile is explicit');
const unverifiedProfileInventory = resolveProviderCapability({
  settings: settingsFor({
    reasoner: configuredProvider('reasoner', { status: 'pass' })
  }),
  lane: 'reasoner',
  operation: 'prompt-packet',
  host: {}
});
assertEqual(unverifiedProfileInventory.state, 'unconfigured', 'missing authoritative profile inventory fails closed');
assertEqual(unverifiedProfileInventory.eligible, false, 'saved profile cannot route when availability is unconfirmed');

for (const [field, mutate] of [
  ['lane', (provider) => ({ ...provider, lane: 'utility' })],
  ['source', (provider) => ({ ...provider, source: 'host-current-model' })],
  ['profile', (provider) => ({ ...provider, hostConnectionProfileId: 'changed-profile' })],
  ['base URL', (provider) => ({ ...provider, openAICompatible: { ...provider.openAICompatible, baseUrl: 'https://changed.invalid/v1' } })],
  ['model', (provider) => ({ ...provider, openAICompatible: { ...provider.openAICompatible, model: 'changed-model' } })],
  ['key presence', (provider) => ({ ...provider, openAICompatible: { ...provider.openAICompatible, sessionApiKeyPresent: !provider.openAICompatible.sessionApiKeyPresent } })],
  ['temperature', (provider) => ({ ...provider, temperature: 0.8 })],
  ['top-p', (provider) => ({ ...provider, topP: 0.8 })],
  ['max tokens', (provider) => ({ ...provider, maxTokens: 4096 })]
]) {
  const original = directProvider;
  assert(
    providerConfigHash(mutate(original)) !== providerConfigHash(original),
    `${field} participates in provider configuration hash`
  );
}

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
  ...directTest,
  secret: 'must-not-survive',
  reasonCode: 'Bearer sk-reason-code-secret',
  message: 'Bearer sk-message-secret'
});
assertDeepEqual(
  Object.keys(sanitized).sort(),
  [
    'configHash',
    'configRevision',
    'configured',
    'eligible',
    'lane',
    'message',
    'ready',
    'reasonCode',
    'required',
    'selectedByPolicy',
    'state',
    'testable'
  ].sort(),
  'sanitized capability exposes only bounded fields'
);
assert(!JSON.stringify(sanitized).includes('must-not-survive'), 'sanitized capability excludes unknown fields');
assert(!JSON.stringify(sanitized).includes('sk-reason-code-secret'), 'sanitized capability does not trust caller reason text');
assert(!JSON.stringify(sanitized).includes('sk-message-secret'), 'sanitized capability does not trust caller message text');
assert(Object.isFrozen(sanitized), 'sanitized capability is immutable');

console.log('[pass] provider capability');
