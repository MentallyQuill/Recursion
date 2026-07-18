import { hashJson, nowIso } from '../core.mjs';
import { validatePromptPacket } from '../prompt.mjs';

export const PREPARED_GENERATION_VERSION = 1;

const PREPARED_GENERATION_SCHEMA = 'recursion.preparedGeneration.v1';

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function handIsValid(hand) {
  return isObject(hand)
    && Array.isArray(hand.cards)
    && Array.isArray(hand.omitted);
}

function sourceIdentityIsValid(identity) {
  return isObject(identity)
    && Number.isFinite(identity.mesid)
    && ['user', 'assistant', 'system'].includes(identity.role)
    && isNonEmptyString(identity.textHash)
    && (identity.swipeId === undefined || isFiniteNonNegativeInteger(identity.swipeId))
    && (identity.swipeCount === undefined || isFiniteNonNegativeInteger(identity.swipeCount))
    && (identity.activeSwipeTextHash === undefined || isNonEmptyString(identity.activeSwipeTextHash));
}

function sourceWindowFor(basis) {
  return Array.isArray(basis?.sourceWindow) ? basis.sourceWindow : [];
}

function basisMetadataIsValid(basis) {
  return isObject(basis)
    && isNonEmptyString(basis.chatKey)
    && isNonEmptyString(basis.sceneKey)
    && isNonEmptyString(basis.sceneFingerprint)
    && isNonEmptyString(basis.sourceRevisionHash)
    && Number.isFinite(basis.latestMesId)
    && isNonEmptyString(basis.sourceWindowContractHash);
}

function basisIsValid(basis) {
  const sourceWindow = sourceWindowFor(basis);
  return basisMetadataIsValid(basis)
    && sourceWindow.length > 0
    && sourceWindow.every(sourceIdentityIsValid);
}

function basisMetadataMatches(expected, current) {
  return basisMetadataIsValid(expected)
    && basisMetadataIsValid(current)
    && expected.chatKey === current.chatKey
    && expected.sceneKey === current.sceneKey
    && expected.sceneFingerprint === current.sceneFingerprint
    && expected.latestMesId === current.latestMesId
    && expected.sourceWindowContractHash === current.sourceWindowContractHash;
}

function contractIsValid(contract) {
  return isObject(contract)
    && contract.preparedGenerationVersion === PREPARED_GENERATION_VERSION
    && Number.isFinite(contract.promptPacketVersion)
    && Number.isFinite(contract.runtimeCacheContractVersion)
    && isNonEmptyString(contract.promptContractHash)
    && isNonEmptyString(contract.providerContractHash)
    && isNonEmptyString(contract.cardCatalogHash)
    && isNonEmptyString(contract.activeDeckRevisionHash)
    && isNonEmptyString(contract.cardEligibilityHash)
    && isNonEmptyString(contract.packetInputHash);
}

export function createPreparedGenerationArtifact({
  packet,
  hand,
  basis,
  contract
} = {}) {
  validatePromptPacket(packet);
  if (!handIsValid(hand)) {
    throw new TypeError('Prepared generation hand is invalid.');
  }
  if (!basisIsValid(basis)) {
    throw new TypeError('Prepared generation basis is invalid.');
  }
  if (!contractIsValid(contract)) {
    throw new TypeError('Prepared generation contract is invalid.');
  }
  const body = {
    schema: PREPARED_GENERATION_SCHEMA,
    version: PREPARED_GENERATION_VERSION,
    packet,
    hand,
    basis,
    contract,
    preparedAt: nowIso()
  };
  return {
    ...body,
    artifactHash: hashJson(body)
  };
}

export function preparedGenerationIntegrityIsValid(artifact) {
  if (!isObject(artifact)) return false;
  if (artifact.schema !== PREPARED_GENERATION_SCHEMA) return false;
  if (artifact.version !== PREPARED_GENERATION_VERSION) return false;
  if (!basisIsValid(artifact.basis) || !contractIsValid(artifact.contract)) return false;
  if (typeof artifact.preparedAt !== 'string' || !artifact.preparedAt) return false;
  if (!handIsValid(artifact.hand)) return false;
  try {
    validatePromptPacket(artifact.packet);
  } catch {
    return false;
  }
  const { artifactHash, ...body } = artifact;
  return typeof artifactHash === 'string'
    && artifactHash.length > 0
    && artifactHash === hashJson(body);
}

export function compareGenerationBasis(
  expected,
  current,
  { allowBoundedSuffix = false } = {}
) {
  if (!basisMetadataMatches(expected, current)) {
    return { matches: false, mode: 'none', reason: 'basis-metadata-mismatch' };
  }

  const expectedWindow = sourceWindowFor(expected);
  const currentWindow = sourceWindowFor(current);
  if (!expectedWindow.length || !currentWindow.length) {
    return { matches: false, mode: 'none', reason: 'basis-window-empty' };
  }
  if (!expectedWindow.every(sourceIdentityIsValid) || !currentWindow.every(sourceIdentityIsValid)) {
    return { matches: false, mode: 'none', reason: 'basis-window-invalid' };
  }

  if (
    expected.sourceRevisionHash === current.sourceRevisionHash
    && hashJson(expectedWindow) === hashJson(currentWindow)
  ) {
    return { matches: true, mode: 'exact', reason: 'basis-exact' };
  }

  if (
    allowBoundedSuffix
    && current.sourceWindowTruncated === true
    && ['message-cap', 'character-budget', 'both'].includes(current.sourceWindowLimitReason)
    && currentWindow.length < expectedWindow.length
    && hashJson(currentWindow) === hashJson(expectedWindow.slice(-currentWindow.length))
  ) {
    return {
      matches: true,
      mode: 'bounded-suffix',
      reason: 'basis-observable-suffix'
    };
  }

  return { matches: false, mode: 'none', reason: 'basis-window-mismatch' };
}

export function validatePreparedGenerationArtifact(
  artifact,
  {
    basis,
    packetInputHash,
    forceFresh = false,
    allowBoundedSuffix = false
  } = {}
) {
  if (forceFresh) {
    return { decision: 'bypassed', reason: 'force-fresh' };
  }
  if (!artifact) {
    return { decision: 'miss', reason: 'artifact-missing' };
  }
  if (!preparedGenerationIntegrityIsValid(artifact)) {
    return { decision: 'invalid', reason: 'artifact-integrity' };
  }
  const basisComparison = compareGenerationBasis(
    artifact.basis,
    basis,
    { allowBoundedSuffix }
  );
  if (!basisComparison.matches) {
    return {
      decision: 'miss',
      reason: 'generation-basis-mismatch',
      basisMode: basisComparison.mode,
      basisReason: basisComparison.reason
    };
  }
  if (!isNonEmptyString(packetInputHash) || artifact.contract.packetInputHash !== packetInputHash) {
    return { decision: 'miss', reason: 'packet-input-mismatch' };
  }
  return {
    decision: 'hit',
    reason: 'prepared-generation-exact-match',
    basisMode: basisComparison.mode
  };
}

export function summarizePreparedGenerationArtifact(artifact) {
  const integrityValid = preparedGenerationIntegrityIsValid(artifact);
  return {
    schema: artifact?.schema === PREPARED_GENERATION_SCHEMA
      ? PREPARED_GENERATION_SCHEMA
      : '',
    version: Number.isFinite(artifact?.version) ? artifact.version : null,
    integrityValid,
    artifactHash: typeof artifact?.artifactHash === 'string' ? artifact.artifactHash : '',
    preparedAt: typeof artifact?.preparedAt === 'string' ? artifact.preparedAt : '',
    packetVersion: Number.isFinite(artifact?.packet?.packetVersion)
      ? artifact.packet.packetVersion
      : null,
    hand: {
      cardCount: Array.isArray(artifact?.hand?.cards) ? artifact.hand.cards.length : 0,
      omittedCount: Array.isArray(artifact?.hand?.omitted) ? artifact.hand.omitted.length : 0
    },
    basis: {
      sourceRevisionHash: typeof artifact?.basis?.sourceRevisionHash === 'string'
        ? artifact.basis.sourceRevisionHash
        : '',
      sourceWindowCount: sourceWindowFor(artifact?.basis).length,
      sourceWindowContractHash: typeof artifact?.basis?.sourceWindowContractHash === 'string'
        ? artifact.basis.sourceWindowContractHash
        : ''
    },
    contract: {
      packetInputHash: typeof artifact?.contract?.packetInputHash === 'string'
        ? artifact.contract.packetInputHash
        : ''
    }
  };
}
