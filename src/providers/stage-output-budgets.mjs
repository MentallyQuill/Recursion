const STATIC_BUDGETS = Object.freeze({
  providerTest: 128,
  utilityArbiter: 4096,
  sceneFrameCard: 900,
  activeCastCard: 900,
  characterMotivationCard: 900,
  dialogueRelationshipCard: 900,
  socialSubtextCard: 900,
  sceneConstraintsCard: 900,
  knowledgeSecretsCard: 900,
  clocksConsequencesCard: 900,
  environmentAffordancesCard: 900,
  possessionsItemsCard: 900,
  openThreadsCard: 900,
  guidanceComposer: 1600,
  reasonerComposer: 1800,
  cardAuthoringAssist: 1200,
  generationReviewer: 1800,
  editorialDiagnostician: 2200,
  editorialVerifier: 1800,
  editorialEffectivenessJudge: 1200,
  postProcessGuidanceUtility: 1400,
  postProcessGuidanceReasoner: 1400
});

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
  if (roleId === 'fusedCardBundle') {
    const count = Math.max(1, Array.isArray(request.requestedCards) ? request.requestedCards.length : 1);
    return clamp(512 + count * 640, 1024, Math.min(7168, hardCeiling));
  }
  if (roleId === 'editorialTransformer') {
    const sourceText = String(request.sourceText || request.metadata?.sourceText || '');
    return clamp(Math.ceil(sourceText.length / 4) + 1024, 1600, Math.min(7000, hardCeiling));
  }
  return clamp(STATIC_BUDGETS[roleId] || 1200, 128, hardCeiling);
}
