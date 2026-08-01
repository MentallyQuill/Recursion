export const LIFECYCLE_PROOF_SECTIONS = Object.freeze([
  'newTurn',
  'unchangedSwipe',
  'editedBandSwipe',
  'reprocessSwipe',
  'fullFreshSwipe',
  'stop',
  'resume',
  'postProcess'
]);

const EXPECTED_FIELDS = Object.freeze({
  newTurn: { arbiterCalls: 1, turnKeyChanged: true },
  unchangedSwipe: { recursionModelCalls: 0, packetReinstalled: true },
  editedBandSwipe: { reuseRejected: true, queuedIntentCanceled: true },
  reprocessSwipe: { selectedStageCalls: 1, intentConsumed: true },
  fullFreshSwipe: { arbiterCalls: 1, requestedCardCalls: 1 },
  stop: { hostStopCalls: 1, promptClears: 1, state: 'paused' },
  resume: { hostStartCalls: 1, detachedProviderCalls: 0 },
  postProcess: { responseIdentityChanged: true, priorRewriteReused: false }
});

export function validateLifecycleProof(proof) {
  const errors = [];
  const source = proof && typeof proof === 'object' ? proof : {};
  for (const section of LIFECYCLE_PROOF_SECTIONS) {
    const actual = source[section];
    if (!actual || typeof actual !== 'object') {
      errors.push(`${section}:missing`);
      continue;
    }
    for (const [field, expected] of Object.entries(EXPECTED_FIELDS[section])) {
      if (actual[field] !== expected) {
        errors.push(`${section}.${field}:expected-${JSON.stringify(expected)}-received-${JSON.stringify(actual[field])}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export function assertLifecycleProof(proof) {
  const validation = validateLifecycleProof(proof);
  if (!validation.ok) {
    throw new Error(`Lifecycle proof contract failed: ${validation.errors.join(', ')}`);
  }
  return proof;
}
