const MINIMUM_BUDGETS = Object.freeze({
  providerTest: 64,
  fusedCardBundle: 768,
  editorialTransformer: 1200,
  default: 384
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function minimumOutputBudgetForRole(roleId) {
  return MINIMUM_BUDGETS[roleId] || MINIMUM_BUDGETS.default;
}

export function outputBudgetForRequest(roleId, request = {}, ceiling = 8192) {
  const hardCeiling = clamp(Number(ceiling) || 8192, 128, 32768);
  const explicit = Number(request.responseLength ?? request.maxTokens);
  if (Number.isFinite(explicit) && explicit > 0) return clamp(explicit, 64, hardCeiling);
  return roleId === 'providerTest' ? Math.min(128, hardCeiling) : hardCeiling;
}
