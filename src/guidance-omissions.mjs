const REASONS = new Set(['duplicate', 'lower-priority', 'unsupported', 'unsafe']);

// Guidance omissions are records, unlike sourceCardIds and guardrailCardIds.
export function normalizeGuidanceOmissions(value, { sanitizeId = (id) => id, limit = 32 } = {}) {
  const records = [];
  const seen = new Set();
  for (const entry of Array.isArray(value) ? value : []) {
    if (!entry || typeof entry.id !== 'string' || !REASONS.has(entry.reason)) continue;
    const id = sanitizeId(entry.id.trim().slice(0, 160));
    if (!id || seen.has(id)) continue;
    seen.add(id);
    records.push({ id, reason: entry.reason });
    if (records.length >= limit) break;
  }
  return records;
}
