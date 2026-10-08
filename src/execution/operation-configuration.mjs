// Record settings used by this operation, never current settings at export time.
export function normalizeOperationConfiguration(value = {}) {
  const hash = input => typeof input === 'string' && /^[a-f0-9]{8}$/.test(input) ? input : null;
  return {
    mode:['auto','manual'].includes(value?.mode) ? value.mode : null,
    cardsPerTurn:Number.isInteger(value?.cardsPerTurn) && value.cardsPerTurn >= 0 && value.cardsPerTurn <= 20
      ? value.cardsPerTurn : null,
    reasoningLevel:['low','medium','high','ultra'].includes(value?.reasoningLevel) ? value.reasoningLevel : null,
    reasonerUse:['auto','always'].includes(value?.reasonerUse) ? value.reasonerUse : null,
    settingsHash:hash(value?.settingsHash),providerHash:hash(value?.providerHash)
  };
}
