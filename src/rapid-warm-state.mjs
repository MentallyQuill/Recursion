const SAFE_TEXT_LIMIT = 180;
const SAFE_LABEL_LIMIT = 240;
const UNSAFE_TEXT_PATTERN = /\b(raw\s*prompt|provider\s*prompt|provider\s*response|hidden\s*reasoning|password|api[-_\s]*key|authorization|cookie|credentials?|session[-_\s]*key|bearer\s+\S+|sk-[a-z0-9_-]+)\b/i;

export const RAPID_WARM_JOIN_WAIT_MS = 4000;

const REASON_LABELS = Object.freeze({
  'not-rapid-mode': 'Standard Pipeline selected.',
  'provider-unavailable': 'Utility provider unavailable.',
  'no-active-variant': 'No Rapid deck for this source yet.',
  warming: 'Rapid deck still warming.',
  'warm-timeout': 'Rapid deck still warming; Standard started.',
  'warm-failed': 'Rapid warm failed; Standard started.',
  'source-mismatch': 'Rapid deck belongs to a different source.',
  'settings-mismatch': 'Rapid deck was built with different settings.',
  'provider-contract-mismatch': 'Rapid deck was built with different provider settings.',
  'catalog-mismatch': 'Rapid deck was built with a different card catalog.',
  'prompt-contract-mismatch': 'Rapid deck was built with a different prompt contract.',
  'story-form-mismatch': 'Rapid deck uses incompatible story-form guidance.',
  'no-candidate-cards': 'Rapid deck has no usable cards.',
  'selected-card-miss': 'Rapid selected cards are missing from cache.',
  'guidance-missing': 'Rapid deck has no usable guidance.',
  'delta-provider-failed': 'Rapid turn guidance failed.',
  'delta-invalid': 'Rapid turn guidance was invalid.',
  'delta-mandatory-gap': 'Rapid found a mandatory context gap.',
  'delta-empty': 'Rapid turn guidance was empty.',
  ready: 'Rapid deck ready.',
  stale: 'Rapid deck stale.',
  failed: 'Rapid warm failed.'
});

function cleanText(value, limit = SAFE_TEXT_LIMIT) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
  return UNSAFE_TEXT_PATTERN.test(text) ? '' : text;
}

function cleanStatus(value) {
  const status = cleanText(value, 40).toLowerCase();
  return ['idle', 'queued', 'warming', 'waiting', 'ready', 'missed', 'stale', 'failed'].includes(status)
    ? status
    : 'idle';
}

function sameHash(left, right) {
  return cleanText(left, 180) === cleanText(right, 180);
}

function guidanceUsable(guidance = {}) {
  return guidance?.schema === 'recursion.guidanceComposer.v1'
    && cleanText(guidance?.text, 6000).length > 0;
}

export function rapidWarmReasonLabel(code) {
  return REASON_LABELS[cleanText(code, 80)] || 'Rapid warm unavailable.';
}

export function rapidWarmMissSnapshot(input = {}) {
  const diagnostics = Array.isArray(input.diagnostics)
    ? input.diagnostics.map((entry) => cleanText(entry, 160)).filter(Boolean).slice(0, 16)
    : [];
  return {
    reasonCode: cleanText(input.reasonCode || 'no-active-variant', 80) || 'no-active-variant',
    reasonLabel: cleanText(input.reasonLabel || rapidWarmReasonLabel(input.reasonCode), SAFE_LABEL_LIMIT)
      || rapidWarmReasonLabel(input.reasonCode),
    exactVariant: input.exactVariant === true,
    joinAttempted: input.joinAttempted === true,
    joinTimedOut: input.joinTimedOut === true,
    activeWarmRunPresent: input.activeWarmRunPresent === true,
    activeWarmRunBaseKnown: input.activeWarmRunBaseKnown === true,
    candidateCardCount: Math.max(0, Math.floor(Number(input.candidateCardCount) || 0)),
    selectedCardCount: Math.max(0, Math.floor(Number(input.selectedCardCount) || 0)),
    diagnostics
  };
}

export function rapidWarmMissReason({
  activeVariant = {},
  rapid = null,
  candidateCards = [],
  expectedContracts = {},
  baseSourceRevisionHash = '',
  storyFormMismatch = false
} = {}) {
  if (!activeVariant?.exact || !rapid) {
    return { code: 'no-active-variant', label: rapidWarmReasonLabel('no-active-variant') };
  }
  if (rapid.status === 'warming' || rapid.status === 'queued') {
    return { code: 'warming', label: rapidWarmReasonLabel('warming') };
  }
  if (rapid.status === 'failed') {
    return { code: 'warm-failed', label: rapidWarmReasonLabel('warm-failed') };
  }
  if (!sameHash(rapid.baseSourceRevisionHash, baseSourceRevisionHash)) {
    return { code: 'source-mismatch', label: rapidWarmReasonLabel('source-mismatch') };
  }
  if (!sameHash(rapid.settingsHash, expectedContracts.settingsHash)) {
    return { code: 'settings-mismatch', label: rapidWarmReasonLabel('settings-mismatch') };
  }
  if (!sameHash(rapid.providerContractHash, expectedContracts.providerContractHash)) {
    return { code: 'provider-contract-mismatch', label: rapidWarmReasonLabel('provider-contract-mismatch') };
  }
  if (!sameHash(rapid.cardCatalogHash, expectedContracts.cardCatalogHash)) {
    return { code: 'catalog-mismatch', label: rapidWarmReasonLabel('catalog-mismatch') };
  }
  if (!sameHash(rapid.promptContractHash, expectedContracts.promptContractHash)) {
    return { code: 'prompt-contract-mismatch', label: rapidWarmReasonLabel('prompt-contract-mismatch') };
  }
  if (storyFormMismatch) {
    return { code: 'story-form-mismatch', label: rapidWarmReasonLabel('story-form-mismatch') };
  }
  if (!Array.isArray(candidateCards) || candidateCards.length === 0) {
    return { code: 'no-candidate-cards', label: rapidWarmReasonLabel('no-candidate-cards') };
  }
  if (!Array.isArray(rapid.selectedCardIds) || rapid.selectedCardIds.length === 0) {
    return { code: 'selected-card-miss', label: rapidWarmReasonLabel('selected-card-miss') };
  }
  if (!guidanceUsable(rapid.guidance)) {
    return { code: 'guidance-missing', label: rapidWarmReasonLabel('guidance-missing') };
  }
  return { code: 'no-active-variant', label: rapidWarmReasonLabel('no-active-variant') };
}

export function rapidWarmStatusView(input = {}) {
  const reasonCode = cleanText(input.reasonCode || input.status || 'idle', 80) || 'idle';
  const fallbackLabel = rapidWarmReasonLabel(reasonCode);
  return {
    status: cleanStatus(input.status),
    pipelineMode: cleanText(input.pipelineMode, 40) === 'rapid' ? 'rapid' : 'standard',
    runId: cleanText(input.runId, 160),
    warmArtifactId: cleanText(input.warmArtifactId, 160),
    baseSourceRevisionHash: cleanText(input.baseSourceRevisionHash, 180),
    startedAt: cleanText(input.startedAt, 80),
    completedAt: cleanText(input.completedAt, 80),
    failedAt: cleanText(input.failedAt, 80),
    selectedCardCount: Math.max(0, Math.floor(Number(input.selectedCardCount) || 0)),
    cardCount: Math.max(0, Math.floor(Number(input.cardCount) || 0)),
    reasonCode,
    reasonLabel: cleanText(input.reasonLabel, SAFE_LABEL_LIMIT) || fallbackLabel,
    joinable: input.joinable === true
  };
}
