export function providerSelector(name, lane) {
  return `[data-recursion-provider-${name}-${lane}]`;
}

export function providerStatusClass(text, { baseClass = '' } = {}) {
  const normalized = String(text || '').trim().toLowerCase();
  const stateClass = normalized === 'not run' || normalized === 'ok' || normalized === 'pass' || normalized === 'passed' || normalized === 'ready'
    ? 'is-ready'
    : (normalized.includes('missing') || normalized.includes('invalid') ? 'is-warning' : 'is-neutral');
  if (!baseClass) return stateClass;
  return `${baseClass}${stateClass === 'is-ready' ? ' pass' : ''}`;
}

export function readProviderDraftFromControls({ root, lane, savedProvider, cleanText, asObject }) {
  const saved = asObject(savedProvider);
  const savedOpenAI = asObject(saved.openAICompatible);
  const read = (name, fallback = '') => {
    const element = root?.querySelector?.(providerSelector(name, lane)) ?? null;
    return element ? cleanText(element.value) : fallback;
  };
  return {
    source: read('source', saved.source || 'host-current-model') || 'host-current-model',
    hostConnectionProfileId: read('profile', saved.hostConnectionProfileId || ''),
    openAICompatible: {
      baseUrl: read('base-url', savedOpenAI.baseUrl || ''),
      model: read('model', savedOpenAI.model || ''),
      sessionApiKeyPresent: Boolean(read('api-key', ''))
    }
  };
}
