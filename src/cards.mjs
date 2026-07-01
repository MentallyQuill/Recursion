import { compact, hashJson, makeId, nowIso, safeId, truncate } from './core.mjs';
import { UTILITY_ROLE_IDS } from './providers.mjs';

const TEXT_LIMIT = 1000;
const SUMMARY_LIMIT = 400;
const EVIDENCE_LIMIT = 12;
const EVIDENCE_TEXT_LIMIT = 120;
const INSPECTOR_NOTES_LIMIT = 800;
const ARBITER_REASON_LIMIT = 240;
const MAX_TOKEN_ESTIMATE = 1000;
const CARD_RESPONSE_SCHEMA = 'recursion.card.v1';

function catalogEntry(entry) {
  return Object.freeze(entry);
}

export const CARD_CATALOG = Object.freeze([
  catalogEntry({
    family: 'Scene Frame',
    role: 'sceneFrameCard',
    priority: 100,
    description: 'Current location, situation, participants, and immediate dramatic direction.'
  }),
  catalogEntry({
    family: 'Active Cast',
    role: 'activeCastCard',
    priority: 95,
    description: 'Who is present, visible state, and current conversational or physical role.'
  }),
  catalogEntry({
    family: 'Character Motivation',
    role: 'characterMotivationCard',
    priority: 88,
    description: 'Observable or safely inferred motives, pressures, hesitations, and goals.'
  }),
  catalogEntry({
    family: 'Dialogue/Relationship',
    role: 'dialogueRelationshipCard',
    priority: 84,
    description: 'Current conversational tension, relationship texture, promises, conflicts, and voice constraints.'
  }),
  catalogEntry({
    family: 'Continuity Risk',
    role: 'continuityRiskCard',
    priority: 98,
    description: 'Facts likely to be contradicted if omitted from the next response.'
  }),
  catalogEntry({
    family: 'Environment/Items',
    role: 'environmentItemsCard',
    priority: 76,
    description: 'Spatial constraints, sensory details, relevant objects, tools, hazards, and nearby affordances.'
  }),
  catalogEntry({
    family: 'Prose/Pacing',
    role: 'prosePacingCard',
    priority: 62,
    description: 'Local craft guidance for density, momentum, specificity, and response shape.'
  }),
  catalogEntry({
    family: 'Open Threads',
    role: 'openThreadsCard',
    priority: 72,
    description: 'Unresolved questions, immediate promises, pending actions, and near-term pressures.'
  })
]);

const CATALOG_BY_FAMILY = new Map(CARD_CATALOG.map((entry) => [entry.family, entry]));
const CATALOG_BY_ROLE = new Map(CARD_CATALOG.map((entry) => [entry.role, entry]));
const STATUS = new Set(['candidate', 'active', 'stowed', 'stale', 'discarded']);
const EMPHASIS = new Set(['normal', 'emphasized', 'muted']);
const DETAIL = new Set(['compact', 'standard', 'expanded']);
const EMPHASIS_PRIORITY = Object.freeze({ emphasized: 0, normal: 1, muted: 2 });
const CARD_FORBIDDEN_PATTERNS = Object.freeze([
  /\bhidden\s+chain[-\s]of[-\s]thought\b/i,
  /\bchain[-\s]of[-\s]thought\b/i,
  /\bprivate\s+chain[-\s]of[-\s]thought\b/i,
  /\b(hidden|private|secret|undisclosed)\s+future\s+(plans?|plot|story)\b/i
]);
const CHARACTER_MOTIVATION_FORBIDDEN_PATTERNS = Object.freeze([
  /\b(?:thinks?|thoughts?|inner\s+monologue|internal\s+monologue)\s*:/i,
  /\b(?:secret|hidden|private|undisclosed)\s+(?:thoughts?|motives?|motivations?|plans?|intentions?)\b/i,
  /\breveal\s+(?:their\s+|his\s+|her\s+|my\s+|our\s+)?(?:inner|private|hidden|secret)\s+thoughts?\b/i,
  /\b[A-Z][A-Za-z0-9_.-]*\s+(?:secretly|privately|silently)\s+(?:wants?|plans?|intends?|hopes?|fears?|feels?|knows?|believes?)\b/i,
  /\b(?:he|she|they)\s+(?:secretly|privately|silently)\s+(?:wants?|plans?|intends?|hopes?|fears?|feels?|knows?|believes?)\b/i,
  /(?:^|[\s"'])I\s+(?:secretly|privately|silently|really|actually)\s+(?:want|wants|plan|plans|intend|intends|hope|hopes|fear|fears|feel|feels|know|knows|believe|believes)\b/i,
  /(?:^|[\s"'])I\s+(?:will|would|can|could|should)\s+never\s+reveal\b/i
]);

for (const entry of CARD_CATALOG) {
  if (!UTILITY_ROLE_IDS.includes(entry.role)) {
    throw new Error(`Card catalog role is not registered as a utility provider role: ${entry.role}`);
  }
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanText(value, limit) {
  return truncate(compact(value ?? '', limit), limit);
}

function cleanOptionalText(value, limit) {
  const text = cleanText(value, limit);
  return text || undefined;
}

function numberInRange(value, fallback, min, max) {
  const number = Number(value);
  const resolved = Number.isFinite(number) ? number : fallback;
  return Math.min(max, Math.max(min, Math.round(resolved)));
}

function optionalNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : undefined;
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

function normalizeEvidenceRefs(value) {
  const list = Array.isArray(value)
    ? value
    : (value === undefined || value === null || value === '' ? [] : [value]);
  return list
    .map((entry) => cleanText(entry, EVIDENCE_TEXT_LIMIT))
    .filter(Boolean)
    .slice(0, EVIDENCE_LIMIT);
}

function hasMessageEvidenceRef(value) {
  return normalizeEvidenceRefs(value).some((entry) => /\bmessage:\d+\b/i.test(entry));
}

function assertCardPromptTextSafe(catalog, promptText) {
  for (const pattern of CARD_FORBIDDEN_PATTERNS) {
    if (pattern.test(promptText)) {
      throw new Error('Card promptText contains unsafe hidden-reasoning wording.');
    }
  }
  if (catalog.family !== 'Character Motivation') return;
  for (const pattern of CHARACTER_MOTIVATION_FORBIDDEN_PATTERNS) {
    if (pattern.test(promptText)) {
      throw new Error('Character Motivation promptText contains unsafe internal-thought wording.');
    }
  }
}

function providerSnapshotMatches(data, context) {
  const expected = String(context?.expectedSnapshotHash ?? context?.snapshotHash ?? '').trim();
  const actual = String(data?.snapshotHash ?? '').trim();
  if (!expected) return true;
  if (!actual) return context?.allowMissingSnapshotHash === true;
  return actual === expected;
}

function cardPromptSafetyInstruction(catalog) {
  if (catalog.family !== 'Character Motivation') return '';
  return 'Do not include first-person internal monologue, secret thoughts as truth, or instructions to reveal inner thoughts. Keep motives behavior-facing and observable or explicitly inferred.';
}

function resolveCatalog(input, { strict = true, allowDefault = false } = {}) {
  const source = asObject(input);
  const family = String(source.family ?? '').trim();
  const role = String(source.role ?? source.roleId ?? '').trim();
  const familyCatalog = CATALOG_BY_FAMILY.get(family);
  const roleCatalog = CATALOG_BY_ROLE.get(role);
  if (familyCatalog && roleCatalog && familyCatalog.role !== roleCatalog.role) {
    if (!strict) return null;
    throw new Error(`Card family and role mismatch: ${family} / ${role}`);
  }
  if (familyCatalog) return familyCatalog;
  if (roleCatalog) return roleCatalog;
  if (!family && !role) {
    if (allowDefault) return CARD_CATALOG[0];
    if (!strict) return null;
    throw new Error('Card family or role is required.');
  }
  if (!strict) return null;
  throw new Error(`Unknown card catalog family or role: ${family || role}`);
}

function hasCatalogIdentity(input) {
  const source = asObject(input);
  return Boolean(String(source.family ?? '').trim() || String(source.role ?? source.roleId ?? '').trim());
}

function hasCompleteCatalogIdentity(input) {
  const source = asObject(input);
  return Boolean(String(source.family ?? '').trim() && String(source.role ?? '').trim());
}

function resolveProviderEnvelopeCatalog(data, context) {
  let expectedCatalog;
  let envelopeCatalog;
  try {
    expectedCatalog = resolveCatalog({
      family: context?.expectedFamily,
      role: context?.expectedRole
    }, { strict: true });
    if (!hasCompleteCatalogIdentity(data)) return null;
    envelopeCatalog = resolveCatalog(data, { strict: true });
  } catch {
    return null;
  }
  if (expectedCatalog && envelopeCatalog.role !== expectedCatalog.role) return null;
  return envelopeCatalog;
}

function itemMatchesProviderCatalog(item, catalog) {
  if (!hasCatalogIdentity(item)) return true;
  try {
    const itemCatalog = resolveCatalog(item, { strict: true });
    return itemCatalog.role === catalog.role;
  } catch {
    return false;
  }
}

function cardIdFor(input, catalog, promptText, context) {
  const seed = `card-${safeId(catalog.family)}-${hashJson({
    family: catalog.family,
    role: catalog.role,
    promptText,
    sceneId: context.sceneId,
    snapshotHash: context.snapshotHash
  })}`;
  return safeId(input.id, seed);
}

function sourceContext(input, context) {
  const source = asObject(input.source);
  const freshness = asObject(input.freshness);
  const snapshotHash = String(
    context.snapshotHash
      ?? input.snapshotHash
      ?? source.snapshotHash
      ?? source.fingerprint
      ?? freshness.sourceFingerprint
      ?? ''
  );
  return {
    sceneId: String(context.sceneId ?? input.sceneId ?? 'scene').trim() || 'scene',
    chatId: String(context.chatId ?? source.chatId ?? input.chatId ?? '').trim(),
    firstMesId: numberInRange(context.firstMesId ?? source.firstMesId ?? input.firstMesId, 0, 0, Number.MAX_SAFE_INTEGER),
    lastMesId: numberInRange(context.lastMesId ?? source.lastMesId ?? input.lastMesId, 0, 0, Number.MAX_SAFE_INTEGER),
    snapshotHash
  };
}

function validEnum(value, allowed, fallback) {
  const text = String(value ?? '').trim();
  return allowed.has(text) ? text : fallback;
}

function stringifyForPrompt(value) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return JSON.stringify({ unavailable: true });
  }
}

function sanitizeHandCard(card) {
  return {
    id: String(card.id || ''),
    family: String(card.family || ''),
    role: String(card.role || ''),
    status: 'active',
    promptText: String(card.promptText || ''),
    tokenEstimate: numberInRange(card.tokenEstimate, estimateTokens(card.promptText), 1, MAX_TOKEN_ESTIMATE),
    detailProfile: validEnum(card.detailProfile, DETAIL, 'standard'),
    emphasis: validEnum(card.emphasis, EMPHASIS, 'normal'),
    evidenceRefs: normalizeEvidenceRefs(card.evidenceRefs)
  };
}

function catalogPriority(card) {
  return CATALOG_BY_FAMILY.get(card.family)?.priority ?? CATALOG_BY_ROLE.get(card.role)?.priority ?? 0;
}

function sortCardsForHand(a, b) {
  const emphasisDelta = (EMPHASIS_PRIORITY[a.emphasis] ?? 1) - (EMPHASIS_PRIORITY[b.emphasis] ?? 1);
  if (emphasisDelta !== 0) return emphasisDelta;
  const priorityDelta = catalogPriority(b) - catalogPriority(a);
  if (priorityDelta !== 0) return priorityDelta;
  return String(a.id || '').localeCompare(String(b.id || ''));
}

function normalizeDeckCard(card, { preserveId = false } = {}) {
  const normalized = normalizeCard(card, {
    sceneId: card?.sceneId,
    snapshotHash: card?.source?.snapshotHash || card?.source?.fingerprint || card?.freshness?.sourceFingerprint || card?.sourceFingerprint
  });
  if (preserveId && typeof card?.id === 'string' && card.id) normalized.id = card.id;
  return normalized;
}

export function normalizeCard(input = {}, context = {}) {
  const source = asObject(input);
  const ctx = asObject(context);
  const catalog = resolveCatalog(source);
  const promptText = cleanText(source.promptText ?? source.text ?? source.claim, TEXT_LIMIT);
  if (!promptText) throw new Error('Card promptText is required.');
  assertCardPromptTextSafe(catalog, promptText);

  const normalizedSource = sourceContext(source, ctx);
  const id = cardIdFor(source, catalog, promptText, normalizedSource);
  const freshness = asObject(source.freshness);
  const arbiter = asObject(source.arbiter);
  const expiresAfterMesId = optionalNumber(freshness.expiresAfterMesId ?? source.expiresAfterMesId);
  const inspectorNotes = cleanOptionalText(source.inspectorNotes, INSPECTOR_NOTES_LIMIT);
  const card = {
    id,
    schemaVersion: 1,
    family: catalog.family,
    role: catalog.role,
    sceneId: normalizedSource.sceneId,
    catalogKey: safeId(catalog.family),
    status: validEnum(source.status, STATUS, 'active'),
    source: {
      chatId: normalizedSource.chatId,
      firstMesId: normalizedSource.firstMesId,
      lastMesId: normalizedSource.lastMesId,
      fingerprint: normalizedSource.snapshotHash,
      snapshotHash: normalizedSource.snapshotHash
    },
    promptText,
    summary: cleanText(source.summary || promptText, SUMMARY_LIMIT),
    evidenceRefs: normalizeEvidenceRefs(source.evidenceRefs ?? source.evidence),
    tokenEstimate: numberInRange(source.tokenEstimate ?? source.tokenCost, estimateTokens(promptText), 1, MAX_TOKEN_ESTIMATE),
    detailProfile: validEnum(source.detailProfile, DETAIL, 'standard'),
    emphasis: validEnum(source.emphasis, EMPHASIS, 'normal'),
    freshness: {
      generatedAt: String(freshness.generatedAt ?? source.generatedAt ?? nowIso()),
      sourceFingerprint: String(normalizedSource.snapshotHash || freshness.sourceFingerprint || ''),
      expiresAfterMesId
    },
    arbiter: {
      lastDecisionId: String(arbiter.lastDecisionId ?? source.decisionId ?? ctx.decisionId ?? ''),
      reason: cleanText(arbiter.reason ?? source.reason ?? '', ARBITER_REASON_LIMIT)
    }
  };
  if (inspectorNotes) card.inspectorNotes = inspectorNotes;
  if (card.freshness.expiresAfterMesId === undefined) delete card.freshness.expiresAfterMesId;
  return card;
}

export function buildCardRequests(plan = {}, context = {}) {
  const cardJobs = Array.isArray(plan?.cardJobs) ? plan.cardJobs : [];
  return cardJobs
    .map((job) => {
      const source = asObject(job);
      const catalog = resolveCatalog({ family: source.family, role: source.role ?? source.roleId }, { strict: false });
      if (!catalog) return null;
      const reason = cleanText(source.reason ?? '', ARBITER_REASON_LIMIT);
      const snapshotHash = String(context.snapshotHash ?? source.snapshotHash ?? '');
      return {
        roleId: catalog.role,
        runId: String(context.runId ?? source.runId ?? ''),
        snapshotHash,
        prompt: [
          `Create one compact ${catalog.family} card for the current scene.`,
          'Return one JSON object only. Do not wrap it in markdown.',
          'The JSON object must use schema "recursion.card.v1" and an "items" array with one card object.',
          `Envelope role must be "${catalog.role}".`,
          `Envelope family must be "${catalog.family}".`,
          snapshotHash ? `Envelope snapshotHash must be "${snapshotHash}".` : '',
          'The card object may contain promptText, summary, evidenceRefs, tokenEstimate, detailProfile, emphasis, and inspectorNotes.',
          'The card object must include at least one evidenceRefs entry containing a message:N reference.',
          'promptText is the only prompt-facing card text. inspectorNotes are private diagnostics for the Recursion inspector.',
          cardPromptSafetyInstruction(catalog),
          reason ? `Arbiter request reason: ${reason}` : '',
          `Snapshot hash: ${snapshotHash}`,
          `Snapshot:\n${stringifyForPrompt(context.snapshot ?? {})}`
        ].filter(Boolean).join('\n\n'),
        metadata: {
          family: catalog.family,
          role: catalog.role,
          catalogKey: safeId(catalog.family),
          priority: catalog.priority,
          reason
        }
      };
    })
    .filter(Boolean);
}

export function cardsFromProviderResult(result, context = {}) {
  if (!result?.ok) return [];
  const data = asObject(result.data);
  if (data.schema !== CARD_RESPONSE_SCHEMA) return [];
  if (Object.prototype.hasOwnProperty.call(data, 'cards')) return [];
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length !== 1) return [];
  const catalog = resolveProviderEnvelopeCatalog(data, context);
  if (!catalog) return [];
  if (!providerSnapshotMatches(data, context)) return [];
  return items.flatMap((item) => {
    const source = asObject(item);
    if (!itemMatchesProviderCatalog(source, catalog)) return [];
    if (!hasMessageEvidenceRef(source.evidenceRefs ?? source.evidence)) return [];
    try {
      return [normalizeCard({
        ...source,
        role: catalog.role,
        family: catalog.family,
        promptText: source.promptText ?? source.text ?? source.claim,
        evidenceRefs: source.evidenceRefs ?? source.evidence,
        tokenEstimate: source.tokenEstimate ?? source.tokenCost,
        inspectorNotes: source.inspectorNotes
      }, context)];
    } catch {
      return [];
    }
  });
}

export function applyCardPlan(existingCards = [], plan = {}) {
  const cards = new Map();
  for (const card of Array.isArray(existingCards) ? existingCards : []) {
    const normalized = normalizeDeckCard(card, { preserveId: true });
    cards.set(normalized.id, normalized);
  }
  for (const card of Array.isArray(plan.acceptedCards) ? plan.acceptedCards : []) {
    const normalized = normalizeDeckCard(card);
    cards.set(normalized.id, normalized);
  }
  for (const action of Array.isArray(plan.lifecycle) ? plan.lifecycle : []) {
    const event = asObject(action);
    const cardId = String(event.cardId ?? event.id ?? '');
    if (!cardId || !cards.has(cardId)) continue;
    const card = cards.get(cardId);
    const actionName = String(event.action ?? '').trim();

    if (actionName === 'stow') {
      card.status = 'stowed';
    } else if (actionName === 'discard') {
      card.status = 'discarded';
    } else if (actionName === 'regenerate') {
      card.status = 'stale';
    } else if (actionName === 'select') {
      card.status = 'active';
    } else if (actionName === 'emphasize') {
      card.status = 'active';
      card.emphasis = 'emphasized';
    } else {
      continue;
    }

    card.arbiter = {
      lastDecisionId: String(event.decisionId ?? plan.decisionId ?? card.arbiter?.lastDecisionId ?? ''),
      reason: cleanText(event.reason ?? card.arbiter?.reason ?? '', ARBITER_REASON_LIMIT)
    };
    cards.set(card.id, card);
  }
  return {
    cards: [...cards.values()],
    updatedAt: nowIso()
  };
}

export function selectHand(cards = [], { maxCards = 6, maxTokens = 700 } = {}) {
  const cardLimit = numberInRange(maxCards, 6, 0, 64);
  const tokenLimit = numberInRange(maxTokens, 700, 0, 20000);
  const active = [];
  const omitted = [];

  for (const card of Array.isArray(cards) ? cards : []) {
    if (card?.status === 'active') {
      active.push(card);
    } else if (card?.id) {
      omitted.push({
        cardId: card.id,
        family: card.family || '',
        reason: 'inactive',
        tokenEstimate: numberInRange(card.tokenEstimate, 0, 0, MAX_TOKEN_ESTIMATE)
      });
    }
  }

  const selected = [];
  let tokenEstimate = 0;
  for (const card of active.slice().sort(sortCardsForHand)) {
    const cardTokens = numberInRange(card.tokenEstimate, estimateTokens(card.promptText), 1, MAX_TOKEN_ESTIMATE);
    if (selected.length >= cardLimit) {
      omitted.push({
        cardId: card.id,
        family: card.family || '',
        reason: 'max-cards',
        tokenEstimate: cardTokens
      });
      continue;
    }
    if (tokenEstimate + cardTokens > tokenLimit) {
      omitted.push({
        cardId: card.id,
        family: card.family || '',
        reason: 'token-budget',
        tokenEstimate: cardTokens
      });
      continue;
    }
    tokenEstimate += cardTokens;
    selected.push(sanitizeHandCard({
      ...card,
      tokenEstimate: cardTokens
    }));
  }

  return {
    handId: makeId('hand'),
    cards: selected,
    omitted,
    tokenEstimate,
    composedAt: nowIso(),
    metadata: {
      maxCards: cardLimit,
      maxTokens: tokenLimit,
      selectedCount: selected.length,
      omittedCount: omitted.length,
      sourceCardCount: Array.isArray(cards) ? cards.length : 0
    }
  };
}
