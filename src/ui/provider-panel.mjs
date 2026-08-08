export function providerSelector(name, lane) {
  return `[data-recursion-provider-${name}-${lane}]`;
}

const CAPABILITY_LABELS = Object.freeze({
  unconfigured: 'Configure',
  uncertified: 'Untested',
  'segmented-ready': 'Ready',
  'fused-ready': 'Ready',
  unhealthy: 'Unhealthy'
});

const CAPABILITY_DETAILS = Object.freeze({
  'segmented-ready': 'Segmented',
  'fused-ready': 'Fused'
});

export function providerCapabilityLabel(state) {
  return CAPABILITY_LABELS[String(state || '').trim().toLowerCase()] || 'Untested';
}

export function providerCapabilityDetail(state) {
  return CAPABILITY_DETAILS[String(state || '').trim().toLowerCase()] || '';
}

export function providerStatusClass(text, { baseClass = '' } = {}) {
  const normalized = String(text || '').trim().toLowerCase();
  const stateClass = ['segmented', 'fused', 'ok', 'pass', 'passed', 'ready'].includes(normalized)
    ? 'is-ready'
    : (['configure', 'issue', 'unhealthy'].includes(normalized) || normalized.includes('missing') || normalized.includes('invalid')
      ? 'is-warning'
      : 'is-neutral');
  if (!baseClass) return stateClass;
  return `${baseClass}${stateClass === 'is-ready' ? ' pass' : ''}`;
}

export function readProviderDraftFromControls({ root, lane, savedProvider, cleanText, asObject }) {
  const saved = asObject(savedProvider);
  const savedPolicy = asObject(saved.generationPolicy);
  const savedSamplers = asObject(saved.samplerOverrides);
  const read = (name, fallback = '') => {
    const element = root?.querySelector?.(providerSelector(name, lane)) ?? null;
    return element ? cleanText(element.value) : fallback;
  };
  return {
    connectionProfileId: read('profile', saved.connectionProfileId || ''),
    generationPolicy: {
      presetMode: read('preset-mode', savedPolicy.presetMode || 'isolated'),
      instructMode: read('instruct-mode', savedPolicy.instructMode || 'auto'),
      samplerMode: read('sampler-mode', savedPolicy.samplerMode || 'profile'),
      structuredOutputMode: read('structured-output-mode', savedPolicy.structuredOutputMode || 'auto')
    },
    samplerOverrides: {
      temperature: Number(read('temperature', savedSamplers.temperature ?? (lane === 'reasoner' ? 0.4 : 0.1))),
      topP: Number(read('top-p', savedSamplers.topP ?? 0.95))
    },
    outputTokenCeiling: Number(read('output-token-ceiling', saved.outputTokenCeiling ?? 8192))
  };
}
