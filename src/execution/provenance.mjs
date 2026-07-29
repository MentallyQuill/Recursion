function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  throw new TypeError('Execution provenance must contain JSON-safe values.');
}

function cleanText(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeSourceIdentity(value = {}) {
  return {
    sourceRevisionHash: cleanText(value.sourceRevisionHash),
    latestMessageId: cleanText(value.latestMessageId),
    selectedSwipeId: cleanText(value.selectedSwipeId),
    characterHash: cleanText(value.characterHash),
    groupHash: cleanText(value.groupHash)
  };
}

function normalizeVersionMap(value = {}) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return {};
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => Number.isFinite(value[key]))
      .map((key) => [key, value[key]])
  );
}

export function normalizeExecutionProvenance(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {};
  if (cleanText(source.chatKey)) normalized.chatKey = cleanText(source.chatKey);
  if (source.sourceIdentity && typeof source.sourceIdentity === 'object') {
    normalized.sourceIdentity = normalizeSourceIdentity(source.sourceIdentity);
  }
  if (cleanText(source.sourceRevisionHash)) {
    normalized.sourceRevisionHash = cleanText(source.sourceRevisionHash);
  }
  if (cleanText(source.settingsHash)) normalized.settingsHash = cleanText(source.settingsHash);
  if (source.provider && typeof source.provider === 'object') {
    normalized.provider = {
      id: cleanText(source.provider.id),
      model: cleanText(source.provider.model)
    };
  }
  if (cleanText(source.pipelineMode)) normalized.pipelineMode = cleanText(source.pipelineMode);
  if (source.promptVersions && typeof source.promptVersions === 'object') {
    normalized.promptVersions = normalizeVersionMap(source.promptVersions);
  }
  for (const key of [
    'providerContractHash',
    'deckRevisionHash',
    'cardConfigurationHash',
    'promptContractHash',
    'postProcessMode',
    'postProcessDeckHash'
  ]) {
    if (cleanText(source[key])) normalized[key] = cleanText(source[key]);
  }
  return normalized;
}

export function buildRunProvenance(value = {}) {
  const normalized = normalizeExecutionProvenance(value);
  return {
    chatKey: cleanText(value.chatKey),
    sourceIdentity: normalizeSourceIdentity(value.sourceIdentity),
    settingsHash: cleanText(value.settingsHash),
    provider: {
      id: cleanText(value.provider?.id),
      model: cleanText(value.provider?.model)
    },
    pipelineMode: cleanText(value.pipelineMode),
    promptVersions: normalizeVersionMap(value.promptVersions),
    ...Object.fromEntries(Object.entries(normalized).filter(([key]) => ![
      'chatKey',
      'sourceIdentity',
      'settingsHash',
      'provider',
      'pipelineMode',
      'promptVersions'
    ].includes(key)))
  };
}

export function compareRunProvenance(expected = {}, actual = {}) {
  const expectedSource = expected && typeof expected === 'object' ? expected : {};
  const actualSource = actual && typeof actual === 'object' ? actual : {};
  const changedFields = [...new Set([
    ...Object.keys(expectedSource),
    ...Object.keys(actualSource)
  ])]
    .sort()
    .filter((key) => {
      const expectedHasKey = Object.prototype.hasOwnProperty.call(expectedSource, key);
      const actualHasKey = Object.prototype.hasOwnProperty.call(actualSource, key);
      if (expectedHasKey !== actualHasKey) return true;
      return JSON.stringify(canonicalize(expectedSource[key]))
        !== JSON.stringify(canonicalize(actualSource[key]));
    });
  return {
    reusable: changedFields.length === 0,
    changedFields
  };
}

export async function stableHash(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('');
}
