import { CARD_SCOPE_CATALOG } from './card-scope.mjs';

// Only request-owned families and fixed codes cross persistence/UI boundaries.
const families = new Set(CARD_SCOPE_CATALOG.map((card) => card.family));
export const FUSED_REJECTION_REASONS = Object.freeze({
  'missing-family': 'The bundle did not return this requested card.',
  'duplicate-family': 'The bundle returned this family more than once. Return exactly one item.',
  'invalid-item-shape': 'The card must contain nonempty promptText and an array of message evidence references.',
  'instruction-shape': 'Use instruction-shaped guidance instead of narrative prose.',
  'hidden-content': 'Do not request hidden reasoning or disclose hidden story information.',
  'private-claim': 'Keep motivation observable or explicitly inferred; do not reveal private thoughts as fact.',
  'evidence-message-missing': 'Use message references from the supplied source window.',
  'invalid-card': 'The card did not pass validation. Follow the supplied card contract.'
});

export function normalizeFusedRejections(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).filter((entry) => {
    if (!families.has(entry?.family) || !Object.hasOwn(FUSED_REJECTION_REASONS, entry?.code) || seen.has(entry.family)) return false;
    seen.add(entry.family);
    return true;
  }).slice(0, 40).map(({ family, code }) => ({ family, code }));
}

export function fusedRejectionReason(code) {
  return FUSED_REJECTION_REASONS[code] || FUSED_REJECTION_REASONS['invalid-card'];
}

export function summarizeFusedOutcome(value = {}) {
  value = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const familyList = (list) => [...new Set((Array.isArray(list) ? list : []).filter((family) => families.has(family)))].slice(0, 40);
  return {
    acceptedFamilies: familyList(value.acceptedFamilies),
    unresolvedFamilies: familyList(value.unresolvedFamilies),
    rejections: normalizeFusedRejections(value.rejections),
    fallback: (value.fallback?.mode || value.fallback) === 'segmented' ? 'segmented' : null
  };
}
