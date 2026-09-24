// Pure selection policy. No wall-clock randomness, persistence or provider calls.
export function normalizeCardSelectionSettings(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const raw = Number(source.cooldownTurns);
  const variety = String(source.variety || '').trim().toLowerCase();
  return {
    variety: ['off', 'low', 'medium', 'high'].includes(variety) ? variety : 'low',
    cooldownTurns: Number.isFinite(raw) ? Math.max(0, Math.min(10, Math.round(raw))) : 0
  };
}

export function cooldownExclusions(history = [], deckId, turns = 0) {
  const cooldown = normalizeCardSelectionSettings({ cooldownTurns: turns }).cooldownTurns;
  const rows = Array.isArray(history) ? history : [];
  const excluded = new Map();
  for (let distance = 0; distance < Math.min(cooldown, rows.length); distance++) {
    const row = rows[rows.length - 1 - distance];
    if (row?.deckId !== deckId) continue;
    for (const card of Array.isArray(row.cards) ? row.cards : []) {
      if (typeof card?.cardId !== 'string' || !card.cardId || excluded.has(card.cardId)) continue;
      excluded.set(card.cardId, { cardId: card.cardId, turnsRemaining: cooldown - distance, reason: 'cooldown' });
    }
  }
  return [...excluded.values()];
}

function seededUnit(seed, salt) {
  let hash = 2166136261;
  for (const char of `${salt}:${seed}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  // Avalanche similar prefixes before converting to a unit interval.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967296;
}

export function selectCardCandidates(candidates = [], { slots = 0, variety = 'low', seed = '' } = {}) {
  const capacity = Math.max(0, Math.floor(Number(slots) || 0));
  const keys = new Set();
  const coverage = new Set();
  const eligible = [];
  const omitted = [];
  for (const candidate of candidates) {
    if (!candidate?.key || keys.has(candidate.key)) continue;
    keys.add(candidate.key);
    const coverageKey = String(candidate.coverageKey || '').trim().toLowerCase();
    if (coverageKey && coverage.has(coverageKey)) {
      omitted.push({ key: candidate.key, reason: 'overlapping-coverage' });
      continue;
    }
    if (coverageKey) coverage.add(coverageKey);
    eligible.push(candidate);
  }
  const selected = eligible.slice(0, capacity);
  const policies = { off: [0, 0], low: [0.25, 2], medium: [0.5, 4], high: [1, Infinity] };
  const [chance, window] = policies[variety] || policies.low;
  const alternatives = eligible.slice(capacity, capacity + window);
  let replacement = null;
  if (selected.length && alternatives.length && seededUnit(seed, 'replace') < chance) {
    const alternative = alternatives[Math.floor(seededUnit(seed, 'candidate') * alternatives.length)];
    const previous = selected[selected.length - 1];
    selected[selected.length - 1] = alternative;
    replacement = { from: previous.key, to: alternative.key };
  }
  const retained = new Set(selected.map(({ key }) => key));
  for (const candidate of eligible) {
    if (!retained.has(candidate.key)) omitted.push({ key: candidate.key, reason: replacement?.from === candidate.key ? 'variety-alternative' : 'max-cards' });
  }
  return { selected, omitted, replacement };
}

// Match execution requirements, not a numeric target: an eligible deck may legitimately be small.
export function missingPlannedCards(cards = [], requirements = []) {
  return requirements.filter((job) => !cards.some((card) => {
    if (card?.status !== 'active' || !String(card.promptText || '').trim()) return false;
    if (job.cardId) return card.origin === 'authored' && card.id === job.cardId;
    return card.origin !== 'authored' && card.family === job.family
      && (job.sourceCardIds || []).every((id) => (card.sourceCardIds || []).includes(id));
  })).map(({ family = '', cardId = '', sourceCardIds = [] }) => ({ family, cardId, sourceCardIds }));
}
