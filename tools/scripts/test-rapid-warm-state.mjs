import {
  RAPID_WARM_JOIN_WAIT_MS,
  rapidWarmMissReason,
  rapidWarmMissSnapshot,
  rapidWarmReasonLabel,
  rapidWarmStatusView
} from '../../src/rapid-warm-state.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

assertEqual(RAPID_WARM_JOIN_WAIT_MS, 4000, 'Rapid foreground join wait is 4000 ms');
assertEqual(rapidWarmReasonLabel('warm-timeout'), 'Rapid deck still warming; Standard started.', 'timeout label is safe');
assertEqual(rapidWarmReasonLabel('settings-mismatch'), 'Rapid deck was built with different settings.', 'settings mismatch label is safe');
assertEqual(rapidWarmReasonLabel('unknown-code'), 'Rapid warm unavailable.', 'unknown reason is generic');

const expectedContracts = {
  settingsHash: 'settings-a',
  providerContractHash: 'provider-a',
  cardCatalogHash: 'catalog-a',
  promptContractHash: 'prompt-a'
};

assertDeepEqual(
  rapidWarmMissReason({
    activeVariant: { exact: false },
    rapid: null,
    candidateCards: [],
    expectedContracts,
    baseSourceRevisionHash: 'base-a'
  }),
  { code: 'no-active-variant', label: 'No Rapid deck for this source yet.' },
  'missing active variant gives no-active-variant'
);

assertDeepEqual(
  rapidWarmMissReason({
    activeVariant: { exact: true },
    rapid: {
      status: 'ready',
      baseSourceRevisionHash: 'base-a',
      settingsHash: 'settings-b',
      providerContractHash: 'provider-a',
      cardCatalogHash: 'catalog-a',
      promptContractHash: 'prompt-a',
      guidance: { schema: 'recursion.guidanceComposer.v1', status: 'used', text: 'Warm guidance.' },
      selectedCardIds: ['card-a'],
      cardIds: ['card-a']
    },
    candidateCards: [{ id: 'card-a' }],
    expectedContracts,
    baseSourceRevisionHash: 'base-a'
  }),
  { code: 'settings-mismatch', label: 'Rapid deck was built with different settings.' },
  'settings mismatch reason is detected'
);

assertDeepEqual(
  rapidWarmMissSnapshot({
    reasonCode: 'warm-timeout',
    exactVariant: true,
    joinAttempted: true,
    joinTimedOut: true,
    activeWarmRunPresent: true,
    activeWarmRunBaseKnown: true,
    candidateCardCount: 2,
    selectedCardCount: 1,
    diagnostics: ['rapid-warm-miss-standard', 'authorization Bearer secret-token']
  }),
  {
    reasonCode: 'warm-timeout',
    reasonLabel: 'Rapid deck still warming; Standard started.',
    exactVariant: true,
    joinAttempted: true,
    joinTimedOut: true,
    activeWarmRunPresent: true,
    activeWarmRunBaseKnown: true,
    candidateCardCount: 2,
    selectedCardCount: 1,
    diagnostics: ['rapid-warm-miss-standard']
  },
  'Rapid miss snapshot is bounded, stable, and redacts unsafe diagnostic text'
);

assertDeepEqual(
  rapidWarmStatusView({
    status: 'warming',
    pipelineMode: 'rapid',
    runId: 'rapid-warm-1',
    baseSourceRevisionHash: 'source-a',
    selectedCardCount: 0,
    cardCount: 0,
    reasonCode: 'warming',
    joinable: true
  }),
  {
    status: 'warming',
    pipelineMode: 'rapid',
    runId: 'rapid-warm-1',
    warmArtifactId: '',
    baseSourceRevisionHash: 'source-a',
    startedAt: '',
    completedAt: '',
    failedAt: '',
    selectedCardCount: 0,
    cardCount: 0,
    elapsedMs: 0,
    reasonCode: 'warming',
    reasonLabel: 'Rapid deck still warming.',
    joinable: true
  },
  'warm status view is sanitized and complete'
);

assertEqual(
  rapidWarmStatusView({
    status: 'ready',
    pipelineMode: 'rapid',
    startedAt: '2026-07-04T00:00:00.000Z',
    completedAt: '2026-07-04T00:00:04.250Z'
  }).elapsedMs,
  4250,
  'Rapid warm status view computes elapsed duration'
);

assert(
  !JSON.stringify(rapidWarmStatusView({
    status: 'failed',
    reasonCode: 'warm-failed',
    reasonLabel: 'authorization: Bearer secret-token'
  })).includes('Bearer'),
  'unsafe detail is not exposed in warm view'
);
