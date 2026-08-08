import { normalizeProviderError } from './provider-errors.mjs';

function connectivityRequest(lane) {
  return {
    lane,
    certification: true,
    structuredOutputMethod: 'prompt-json',
    responseLength: 128,
    prompt: [
      'Return one JSON object only.',
      '{"schema":"recursion.providerTest.v1","ok":true}'
    ].join('\n')
  };
}

function singleCardRequest(lane, method) {
  return {
    lane,
    certification: true,
    structuredOutputMethod: method,
    responseLength: 900,
    snapshotHash: 'profile-certification',
    metadata: { role: 'sceneFrameCard', family: 'Scene Frame' },
    prompt: 'Return {"promptText":"one short instruction","evidenceRefs":["message:0"]}.'
  };
}

function fusedCardRequest(lane, method) {
  return {
    lane,
    certification: true,
    structuredOutputMethod: method,
    responseLength: 1792,
    snapshotHash: 'profile-certification',
    requestedCards: [
      { role: 'sceneFrameCard', family: 'Scene Frame' },
      { role: 'sceneConstraintsCard', family: 'Scene Constraints' }
    ],
    prompt: 'Return two requested card items in one JSON items array.'
  };
}

function validConnectivity(result) {
  return result?.ok === true
    && result?.data?.schema === 'recursion.providerTest.v1'
    && result?.data?.ok === true;
}

function validSingleCard(result) {
  return result?.ok === true
    && typeof result?.data?.promptText === 'string'
    && result.data.promptText.trim().length > 0
    && Array.isArray(result?.data?.evidenceRefs)
    && result.data.evidenceRefs.every((ref) => typeof ref === 'string');
}

function validFusedCards(result) {
  if (result?.ok !== true || !Array.isArray(result?.data?.items)) return false;
  const families = result.data.items.map((item) => String(item?.family || '').trim());
  return result.data.items.length === 2
    && new Set(families).size === 2
    && families.includes('Scene Frame')
    && families.includes('Scene Constraints')
    && result.data.items.every((item) => validSingleCard({ ok: true, data: item }));
}

function errorCode(result) {
  return String(result?.error?.code || '').trim();
}

function isNativeSchemaFailure(result) {
  return errorCode(result) === 'RECURSION_STRUCTURED_OUTPUT_UNSUPPORTED';
}

function certificationResult({
  status,
  checkedAt,
  completionMode,
  structuredOutput,
  checks,
  diagnostics,
  error = null
}) {
  const normalizedError = error ? normalizeProviderError(error) : null;
  return Object.freeze({
    status,
    checkedAt,
    completionMode: ['chat', 'text'].includes(completionMode) ? completionMode : 'unknown',
    structuredOutput,
    checks: Object.freeze({ ...checks }),
    safeConcurrency: 1,
    diagnosticCodes: Object.freeze([...new Set(diagnostics)].slice(0, 12)),
    compactError: normalizedError
      ? `${normalizedError.code}: ${normalizedError.message}`.slice(0, 300)
      : ''
  });
}

export async function certifyConnectionProfile({
  lane,
  provider,
  profile,
  generate,
  now = () => new Date().toISOString()
}) {
  if (typeof generate !== 'function') throw new TypeError('Profile certification requires generate.');
  const diagnostics = [];
  const checks = { connectivity: 'not-run', singleCard: 'not-run', fusedCards: 'not-run' };
  const completionMode = profile?.completionMode || 'unknown';

  let connectivity;
  try {
    connectivity = await generate('providerTest', connectivityRequest(lane));
  } catch (error) {
    connectivity = { ok: false, error };
  }
  if (!validConnectivity(connectivity)) {
    return certificationResult({
      status: 'fail',
      checkedAt: now(),
      completionMode,
      structuredOutput: 'unknown',
      checks: { ...checks, connectivity: 'fail' },
      diagnostics,
      error: connectivity?.error || {
        code: 'RECURSION_PROVIDER_TEST_INVALID',
        message: 'Profile connectivity check returned invalid structured data.'
      }
    });
  }
  checks.connectivity = 'pass';

  const configuredMethod = provider?.generationPolicy?.structuredOutputMode || 'auto';
  const allowDowngrade = configuredMethod === 'auto';
  let method = configuredMethod === 'prompt-json' ? 'prompt-json' : 'native-schema';
  let single;
  try {
    single = await generate('sceneFrameCard', singleCardRequest(lane, method));
  } catch (error) {
    single = { ok: false, error };
  }
  if (!validSingleCard(single)
      && method === 'native-schema'
      && allowDowngrade
      && isNativeSchemaFailure(single)) {
    diagnostics.push('structured-output-downgraded');
    method = 'prompt-json';
    try {
      single = await generate('sceneFrameCard', singleCardRequest(lane, method));
    } catch (error) {
      single = { ok: false, error };
    }
  }
  checks.singleCard = validSingleCard(single) ? 'pass' : 'fail';
  if (checks.singleCard === 'fail') {
    return certificationResult({
      status: 'fail',
      checkedAt: now(),
      completionMode,
      structuredOutput: method,
      checks,
      diagnostics,
      error: single?.error || {
        code: 'RECURSION_PROVIDER_SINGLE_CARD_INVALID',
        message: 'Profile single-card check returned invalid structured data.'
      }
    });
  }

  let fused;
  try {
    fused = await generate('fusedCardBundle', fusedCardRequest(lane, method));
  } catch (error) {
    fused = { ok: false, error };
  }
  checks.fusedCards = validFusedCards(fused) ? 'pass' : 'fail';
  return certificationResult({
    status: checks.fusedCards === 'pass' ? 'pass' : 'partial',
    checkedAt: now(),
    completionMode,
    structuredOutput: method,
    checks,
    diagnostics,
    error: checks.fusedCards === 'fail'
      ? (fused?.error || {
          code: 'RECURSION_PROVIDER_FUSED_INVALID',
          message: 'Profile Fused-card check returned invalid structured data.'
        })
      : null
  });
}
