import { compact, hashJson, makeId, nowIso, redact, safeId, truncate } from './core.mjs';
import { CARD_SCOPE_CATALOG } from './card-scope.mjs';
import { UTILITY_ROLE_IDS } from './providers.mjs';
import { summarizeBehaviorPolicyForDiagnostics } from './settings-policy.mjs';
import { UNKNOWN_STORY_FORM, normalizeStoryForm, storyFormPromptBlock } from './story-form.mjs';

const TEXT_LIMIT = 1000;
const CARD_TEXT_LIMIT = Infinity;
const SUMMARY_LIMIT = 400;
const EVIDENCE_LIMIT = 12;
const EVIDENCE_TEXT_LIMIT = 120;
const INSPECTOR_NOTES_LIMIT = 800;
const ARBITER_REASON_LIMIT = 240;
const MAX_TOKEN_ESTIMATE = 1000;
const CARD_RESPONSE_SCHEMA = 'recursion.card.v1';
const CARD_BUNDLE_RESPONSE_SCHEMA = 'recursion.cardBundle.v1';
const PROVIDER_PROMPT_SECRET_KEY_SUFFIXES = Object.freeze([
  'apikey',
  'authorization',
  'auth',
  'authentication',
  'authheader',
  'cookie',
  'cookieheader',
  'token',
  'password',
  'secret',
  'session',
  'sessionkey',
  'bearer',
  'privatekey',
  'credential',
  'credentials'
]);
const PROVIDER_PROMPT_SECRET_KEY_QUALIFIERS = Object.freeze([
  'hash',
  'value',
  'header',
  'pem',
  'material',
  'body',
  'text',
  'string',
  'id'
]);
const PROVIDER_PROMPT_SECRET_ASSIGNMENT_PATTERN = /\b([A-Za-z][A-Za-z0-9_-]*)\s*([:=])\s*("[^"]*"|'[^']*'|Bearer\s+[\s\S]*?|[\s\S]*?)(?=\s+(?:[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*|\[[^\]]+\])?\s*[:=]|[{\[])|[,;\n]|$)/gi;
const PROVIDER_PROMPT_BRACKET_ASSIGNMENT_PATTERN = /\[[\\"']+([A-Za-z][A-Za-z0-9_-]*)[\\"']+\]\s*[:=]\s*("[^"]*"|'[^']*'|Bearer\s+[\s\S]*?|[\s\S]*?)(?=\s+(?:[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*|\[[^\]]+\])?\s*[:=]|[{\[])|[,;\n]|$)/gi;
const PROVIDER_PROMPT_SINGLE_QUOTED_PAIR_PATTERN = /'([^']+)'\s*:\s*('(?:[^'\\]|\\.)*'|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/g;
const PROVIDER_PROMPT_MALFORMED_SECRET_JSON_PAIR_PATTERN = /(["'])([A-Za-z0-9_.-]*(?:apiKey|authorization|auth|cookie|token|password|secret|session|bearer|privateKey|credential)[A-Za-z0-9_.-]*)\1\s*:\s*(["'])([^"'}\]]+)\3/gi;
const PROVIDER_PROMPT_AMBIGUOUS_COLON_KEYS = new Set(['bearer', 'secret', 'session', 'token']);

function catalogEntry(entry) {
  return Object.freeze(entry);
}

export const CARD_CATALOG = Object.freeze([
  catalogEntry({
    family: 'Scene Frame',
    role: 'sceneFrameCard',
    priority: 100,
    description: 'Current location, situation, immediate direction, and hard beat boundary.'
  }),
  catalogEntry({
    family: 'Active Cast',
    role: 'activeCastCard',
    priority: 95,
    description: 'Who is present, visible state, and current conversational or physical role.'
  }),
  catalogEntry({
    family: 'Scene Constraints',
    role: 'sceneConstraintsCard',
    priority: 98,
    description: 'Hard limits, contradiction traps, timing, access, visibility, and plausibility constraints.'
  }),
  catalogEntry({
    family: 'Knowledge',
    role: 'knowledgeSecretsCard',
    priority: 92,
    description: 'Concealed facts, who knows or suspects them, mistaken beliefs, and reveal boundaries.'
  }),
  catalogEntry({
    family: 'Consequences',
    role: 'clocksConsequencesCard',
    priority: 90,
    description: 'Deadlines, countdowns, delayed consequences, and escalation triggers.'
  }),
  catalogEntry({
    family: 'Character Motivation',
    role: 'characterMotivationCard',
    priority: 88,
    description: 'Observable or safely inferred motives, pressures, hesitations, and goals.'
  }),
  catalogEntry({
    family: 'Relationship',
    role: 'dialogueRelationshipCard',
    priority: 84,
    description: 'Current social tension, leverage, promises, conflicts, and speech constraints.'
  }),
  catalogEntry({
    family: 'Social Subtext',
    role: 'socialSubtextCard',
    priority: 82,
    description: 'Scene-observable implied social meaning such as humor, veiled pressure, invitation, boundaries, status, and face.'
  }),
  catalogEntry({
    family: 'Items',
    role: 'possessionsItemsCard',
    priority: 78,
    description: 'Important held, carried, worn, hidden, lost, stolen, or controlled objects and who has them.'
  }),
  catalogEntry({
    family: 'Environment',
    role: 'environmentAffordancesCard',
    priority: 76,
    description: 'Spatial layout, sensory texture, hazards, obstacles, exits, and usable environmental affordances.'
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
const CARD_SCOPE_BY_FAMILY = new Map(CARD_SCOPE_CATALOG.map((entry) => [entry.family, entry]));
const STATUS = new Set(['candidate', 'active', 'stowed', 'stale', 'discarded']);
const EMPHASIS = new Set(['normal', 'emphasized', 'muted']);
const DETAIL = new Set(['compact', 'standard', 'expanded']);
const ORIGIN = new Set(['cache', 'generated', 'fallback']);
const EMPHASIS_PRIORITY = Object.freeze({ emphasized: 0, normal: 1, muted: 2 });
const CARD_FORBIDDEN_PATTERNS = Object.freeze([
  /\bhidden\s+chain[-\s]of[-\s]thought\b/i,
  /\bchain[-\s]of[-\s]thought\b/i,
  /\bprivate\s+chain[-\s]of[-\s]thought\b/i,
  /\b(hidden|private|secret|undisclosed)\s+(internal\s+)?thoughts?\b/i,
  /\b(private|hidden|secret|undisclosed)\s+(character\s+)?motives?\b/i,
  /\b(hidden|private|secret|undisclosed)\s+future\s+(plans?|plot|story)\b/i,
  /\breveal\s+future\s+plans?\b/i,
  /\bfuture[-\s]plot\b/i,
  /\b(hidden|private|secret|undisclosed)\s+spoilers?\b/i,
  /\breveal\s+spoilers?\b/i
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

function isProviderPromptSecretKey(value) {
  const key = providerPromptKey(value);
  if (!key || key.endsWith('count')) return false;
  return PROVIDER_PROMPT_SECRET_KEY_SUFFIXES.some((suffix) => {
    if (key === suffix || key.endsWith(suffix)) return true;
    return PROVIDER_PROMPT_SECRET_KEY_QUALIFIERS.some((qualifier) => {
      const compound = `${suffix}${qualifier}`;
      return key === compound || key.endsWith(compound);
    });
  });
}

function providerPromptKey(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9]+/g, '').toLowerCase();
}

function isHighConfidenceSecretAssignmentValue(value) {
  const text = String(value ?? '').replace(/^["']|["']$/g, '').toLowerCase();
  return /\bbearer\s+\S+/.test(text)
    || /\bsk-[a-z0-9_-]+\b/i.test(text)
    || /\braw[-_\s]/.test(text)
    || /\b(api[-_\s]*key|authorization|credential|password|private[-_\s]*key|secret[-_\s]*value|session[-_\s]*key|token[-_\s]*value)\b/.test(text)
    || /[a-z0-9_+/=-]{24,}/i.test(text);
}

function shouldRedactProviderPromptAssignment(key, delimiter, value) {
  if (!isProviderPromptSecretKey(key)) return false;
  if (delimiter === ':' && PROVIDER_PROMPT_AMBIGUOUS_COLON_KEYS.has(providerPromptKey(key))) {
    return isHighConfidenceSecretAssignmentValue(value);
  }
  return true;
}

function jsonQuoteInfo(text, start) {
  if (text[start] === '"' || text[start] === "'") {
    return { quote: text[start], contentStart: start + 1, escaped: false };
  }
  if (text[start] === '\\' && (text[start + 1] === '"' || text[start + 1] === "'")) {
    return { quote: text[start + 1], contentStart: start + 2, escaped: true };
  }
  return null;
}

function jsonStringBounds(text, start) {
  const info = jsonQuoteInfo(text, start);
  const quote = info?.quote;
  if (quote !== '"' && quote !== "'") return -1;
  let index = info.contentStart;
  while (index < text.length) {
    const char = text[index];
    if (info.escaped) {
      if (char === '\\' && text[index + 1] === quote && text[index - 1] !== '\\') {
        return { start, contentStart: info.contentStart, contentEnd: index, end: index + 1, quote, escaped: true };
      }
      index += 1;
      continue;
    }
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) {
      return { start, contentStart: info.contentStart, contentEnd: index, end: index, quote, escaped: false };
    }
    index += 1;
  }
  return -1;
}

function jsonStringEnd(text, start) {
  const bounds = jsonStringBounds(text, start);
  return bounds === -1 ? -1 : bounds.end;
}

function jsonNestedEnd(text, start, open, close) {
  let depth = 0;
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (jsonQuoteInfo(text, index)) {
      const end = jsonStringEnd(text, index);
      if (end < 0) return -1;
      index = end + 1;
      continue;
    }
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return -1;
}

function jsonPrimitiveEnd(text, start) {
  let index = start;
  while (index < text.length && !/[\s,}\]]/.test(text[index])) index += 1;
  return index > start ? index - 1 : -1;
}

function jsonValueEnd(text, start) {
  const char = text[start];
  if (jsonQuoteInfo(text, start)) return jsonStringEnd(text, start);
  if (char === '{') return jsonNestedEnd(text, start, '{', '}');
  if (char === '[') return jsonNestedEnd(text, start, '[', ']');
  return jsonPrimitiveEnd(text, start);
}

function redactedJsonPair(bounds) {
  if (bounds?.escaped) {
    const quote = bounds.quote === "'" ? "\\'" : '\\"';
    return `${quote}[redactedKey]${quote}:${quote}[redacted]${quote}`;
  }
  if (bounds?.quote === "'") return "'[redactedKey]':'[redacted]'";
  return '"[redactedKey]":"[redacted]"';
}

function scrubJsonStringContent(text, bounds) {
  const prefix = text.slice(bounds.start, bounds.contentStart);
  const suffix = text.slice(bounds.contentEnd, bounds.end + 1);
  const originalContent = text.slice(bounds.contentStart, bounds.contentEnd);
  let content = originalContent;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const normalized = content.replace(/\\+(["'])/g, '\\$1');
    const scrubbed = scrubProviderPromptSecrets(normalized);
    if (scrubbed === normalized && normalized !== content) break;
    if (scrubbed === content) break;
    content = scrubbed;
  }
  return `${prefix}${content === originalContent.replace(/\\+(["'])/g, '\\$1') ? originalContent : content}${suffix}`;
}

function redactJsonSecretPairs(value) {
  const text = String(value ?? '');
  let output = '';
  let index = 0;
  while (index < text.length) {
    let keyStart = -1;
    for (let cursor = index; cursor < text.length; cursor += 1) {
      if (jsonQuoteInfo(text, cursor)) {
        keyStart = cursor;
        break;
      }
    }
    if (keyStart < 0) {
      output += text.slice(index);
      break;
    }

    const keyBounds = jsonStringBounds(text, keyStart);
    if (keyBounds === -1) {
      output += text.slice(index);
      break;
    }
    const keyEnd = keyBounds.end;

    let colonIndex = keyEnd + 1;
    while (colonIndex < text.length && /\s/.test(text[colonIndex])) colonIndex += 1;
    if (text[colonIndex] !== ':') {
      output += text.slice(index, keyEnd + 1);
      index = keyEnd + 1;
      continue;
    }

    let valueStart = colonIndex + 1;
    while (valueStart < text.length && /\s/.test(text[valueStart])) valueStart += 1;
    const valueEnd = jsonValueEnd(text, valueStart);
    if (valueEnd < 0) {
      const key = text.slice(keyBounds.contentStart, keyBounds.contentEnd);
      if (isProviderPromptSecretKey(key)) {
        output += `${text.slice(index, keyStart)}${redactedJsonPair(keyBounds)}`;
        break;
      }
      output += text.slice(index, keyEnd + 1);
      index = keyEnd + 1;
      continue;
    }

    const key = text.slice(keyBounds.contentStart, keyBounds.contentEnd);
    if (!isProviderPromptSecretKey(key)) {
      if (text[valueStart] === '{' || text[valueStart] === '[') {
        output += text.slice(index, valueStart);
        output += redactJsonSecretPairs(text.slice(valueStart, valueEnd + 1));
        index = valueEnd + 1;
        continue;
      }
      const valueBounds = jsonStringBounds(text, valueStart);
      if (valueBounds !== -1) {
        output += text.slice(index, valueStart);
        output += scrubJsonStringContent(text, valueBounds);
        index = valueEnd + 1;
        continue;
      }
      output += text.slice(index, valueEnd + 1);
      index = valueEnd + 1;
      continue;
    }

    output += `${text.slice(index, keyStart)}${redactedJsonPair(keyBounds)}`;
    index = valueEnd + 1;
  }
  return output;
}

function scrubProviderPromptSecrets(value) {
  return redactJsonSecretPairs(value)
    .replace(PROVIDER_PROMPT_SINGLE_QUOTED_PAIR_PATTERN, (match, key) => (isProviderPromptSecretKey(key) ? "'[redactedKey]':'[redacted]'" : match))
    .replace(PROVIDER_PROMPT_MALFORMED_SECRET_JSON_PAIR_PATTERN, (match, keyQuote, key, valueQuote) => (
      isProviderPromptSecretKey(key) ? `${keyQuote}[redactedKey]${keyQuote}:${valueQuote}[redacted]${valueQuote}` : match
    ))
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, 'sk-[redacted]')
    .replace(/\bprivate[-_\s]*secret\b/gi, '[redacted]')
    .replace(PROVIDER_PROMPT_BRACKET_ASSIGNMENT_PATTERN, (match, key) => (isProviderPromptSecretKey(key) ? '[redacted]' : match))
    .replace(PROVIDER_PROMPT_SECRET_ASSIGNMENT_PATTERN, (match, key, delimiter, assignmentValue) => (
      shouldRedactProviderPromptAssignment(key, delimiter, assignmentValue) ? '[redacted]' : match
    ));
}

function scrubProviderPromptStructured(value, visiting = new WeakSet()) {
  if (typeof value === 'string') return scrubProviderPromptSecrets(value);
  if (!value || typeof value !== 'object') return value;
  if (visiting.has(value)) return '[Circular]';
  visiting.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => scrubProviderPromptStructured(entry, visiting));
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      isProviderPromptSecretKey(key) ? '[redactedKey]' : key,
      isProviderPromptSecretKey(key) ? '[redacted]' : scrubProviderPromptStructured(child, visiting)
    ]));
  } finally {
    visiting.delete(value);
  }
}

function cleanProviderPromptText(value, limit) {
  return cleanText(scrubProviderPromptSecrets(value), limit);
}

function scopeCatalogForFamily(family) {
  return CARD_SCOPE_BY_FAMILY.get(String(family || '').trim()) || null;
}

function selectedScopeFacetRows(family, selectedSubItems = []) {
  const scope = scopeCatalogForFamily(family);
  const selected = new Set((Array.isArray(selectedSubItems) ? selectedSubItems : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean));
  if (!scope || selected.size === 0) return [];
  return scope.subItems
    .filter((item) => selected.has(item.key))
    .map((item) => ({
      key: cleanProviderPromptText(item.key, 80),
      label: cleanProviderPromptText(item.label, 120),
      description: cleanProviderPromptText(item.description, 260)
    }));
}

function cardScopePromptBlock(catalog, selectedSubItems = []) {
  const family = cleanProviderPromptText(catalog.family, 120);
  const rows = selectedScopeFacetRows(family, selectedSubItems);
  if (!rows.length) {
    return [
      `Selected focus facets for ${family}: none selected.`,
      'Generate this family only because the Arbiter requested it as high-relevance.',
      'Do not create separate cards per facet.'
    ].join('\n');
  }
  return [
    `Selected focus facets for ${family}:`,
    ...rows.map((item) => `- ${item.key} (${item.label}): ${item.description}`),
    'Use these facets to shape this one family card.',
    'Do not create separate cards per facet.'
  ].join('\n');
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
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
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

function evidenceRefEntries(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function messageEvidenceRefs(value) {
  return evidenceRefEntries(value)
    .flatMap((entry) => [...String(entry ?? '').matchAll(/\bmessage:(\d+)\b/gi)].map((match) => Number(match[1])))
    .filter((entry) => Number.isSafeInteger(entry));
}

function hasValidMessageEvidenceRefs(value, context = {}) {
  const refs = messageEvidenceRefs(value);
  if (refs.length === 0) return false;
  const firstMesId = optionalNumber(context.firstMesId);
  const lastMesId = optionalNumber(context.lastMesId);
  if (firstMesId === undefined || lastMesId === undefined) return true;
  const minMesId = Math.min(firstMesId, lastMesId);
  const maxMesId = Math.max(firstMesId, lastMesId);
  return refs.every((entry) => entry >= minMesId && entry <= maxMesId);
}

function sourceWindowFallbackEvidenceRefs(context = {}) {
  const lastMesId = optionalNumber(context.lastMesId);
  const firstMesId = optionalNumber(context.firstMesId);
  const fallback = lastMesId ?? firstMesId;
  if (!Number.isSafeInteger(fallback)) return null;
  return [`message:${fallback}`];
}

function repairProviderEvidenceRefs(value, context = {}) {
  const entries = evidenceRefEntries(value);
  const fallback = sourceWindowFallbackEvidenceRefs(context);
  if (entries.length === 0) return fallback || value;
  const refs = messageEvidenceRefs(entries);
  if (hasValidMessageEvidenceRefs(entries, context)) return value;
  const firstMesId = optionalNumber(context.firstMesId);
  const lastMesId = optionalNumber(context.lastMesId);
  if (firstMesId === undefined || lastMesId === undefined) return value;
  const minMesId = Math.min(firstMesId, lastMesId);
  const maxMesId = Math.max(firstMesId, lastMesId);
  const validEntries = entries.filter((entry) => {
    const entryRefs = messageEvidenceRefs([entry]);
    return entryRefs.length > 0 && entryRefs.every((ref) => ref >= minMesId && ref <= maxMesId);
  });
  if (validEntries.length > 0) return validEntries;
  return fallback || value;
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
  if (!actual) return true;
  return actual === expected;
}

function cardPromptSafetyInstruction(catalog) {
  if (catalog.family === 'Social Subtext') {
    return 'Do not turn this into generic dialogue style coaching. Keep subtext scene-observable, deniable when uncertain, and separate from private desire or hidden motives as fact.';
  }
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
  return Boolean(String(source.family ?? '').trim() && String(source.role ?? source.roleId ?? '').trim());
}

function resolveProviderEnvelopeCatalog(data, context) {
  let expectedCatalog;
  let envelopeCatalog;
  try {
    expectedCatalog = resolveCatalog({
      family: context?.expectedFamily,
      role: context?.expectedRole
    }, { strict: true });
    if (!expectedCatalog) return null;
    if (hasCatalogIdentity(data)) {
      envelopeCatalog = resolveCatalog({
        family: String(data?.family ?? '').trim() || expectedCatalog.family,
        role: String(data?.role ?? data?.roleId ?? '').trim() || expectedCatalog.role
      }, { strict: true });
    } else {
      envelopeCatalog = expectedCatalog;
    }
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

function providerCardRejectReason(result, context = {}) {
  if (!result?.ok) return 'provider-failed';
  const data = asObject(result.data);
  if (data.schema !== CARD_RESPONSE_SCHEMA) return 'schema-mismatch';
  const items = Array.isArray(data.items)
    ? data.items
    : (Array.isArray(data.cards) ? data.cards : []);
  if (items.length !== 1) return `item-count-${items.length}`;
  const catalog = resolveProviderEnvelopeCatalog(data, context);
  if (!catalog) return 'catalog-mismatch';
  if (!providerSnapshotMatches(data, context)) return 'snapshot-mismatch';
  const item = asObject(items[0]);
  if (!itemMatchesProviderCatalog(item, catalog)) return 'item-catalog-mismatch';
  const evidenceRefs = repairProviderEvidenceRefs(item.evidenceRefs ?? item.evidence, context);
  if (!hasValidMessageEvidenceRefs(evidenceRefs, context)) return 'evidence-message-missing';
  try {
    normalizeCard({
      ...item,
      role: catalog.role,
      family: catalog.family,
      promptText: item.promptText ?? item.text ?? item.claim,
      evidenceRefs,
      tokenEstimate: item.tokenEstimate ?? item.tokenCost,
      inspectorNotes: item.inspectorNotes
    }, context);
  } catch (error) {
    return safeId(cleanText(error?.message || error || 'normalization-failed', 120), 'normalization-failed');
  }
  return '';
}

function cardIdFor(input, catalog, promptText, context) {
  const seed = `card-${safeId(catalog.family)}-${hashJson({
    family: catalog.family,
    role: catalog.role,
    promptText,
    sceneId: context.sceneId,
    snapshotHash: context.snapshotHash,
    sourceRevisionHash: context.sourceRevisionHash
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
  const sourceRevisionHash = String(
    context.sourceRevisionHash
      ?? input.sourceRevisionHash
      ?? source.sourceRevisionHash
      ?? freshness.sourceRevisionHash
      ?? snapshotHash
  );
  return {
    sceneId: String(context.sceneId ?? input.sceneId ?? 'scene').trim() || 'scene',
    chatId: String(context.chatId ?? source.chatId ?? input.chatId ?? '').trim(),
    firstMesId: numberInRange(context.firstMesId ?? source.firstMesId ?? input.firstMesId, 0, 0, Number.MAX_SAFE_INTEGER),
    lastMesId: numberInRange(context.lastMesId ?? source.lastMesId ?? input.lastMesId, 0, 0, Number.MAX_SAFE_INTEGER),
    snapshotHash,
    sourceRevisionHash
  };
}

function validEnum(value, allowed, fallback) {
  const text = String(value ?? '').trim();
  return allowed.has(text) ? text : fallback;
}

function optionalEnum(value, allowed) {
  const text = String(value ?? '').trim();
  return allowed.has(text) ? text : '';
}

function stringifyForPrompt(value) {
  try {
    const scrubbed = scrubProviderPromptStructured(value ?? {});
    return scrubProviderPromptSecrets(JSON.stringify(redact(scrubbed, { maxString: TEXT_LIMIT }), null, 2));
  } catch {
    return JSON.stringify({ unavailable: true });
  }
}

function sanitizeHandCard(card) {
  const handCard = {
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
  const origin = optionalEnum(card.origin, ORIGIN);
  if (origin) handCard.origin = origin;
  return handCard;
}

function catalogPriority(card) {
  return CATALOG_BY_FAMILY.get(card.family)?.priority ?? CATALOG_BY_ROLE.get(card.role)?.priority ?? 0;
}

function behaviorPolicyForHand(policy) {
  return policy && typeof policy === 'object' && !Array.isArray(policy) ? policy : null;
}

function boostedFamilySet(policy) {
  return new Set(Array.isArray(policy?.focus?.boostedFamilies) ? policy.focus.boostedFamilies : []);
}

function focusDelta(a, b, policy) {
  const boosted = boostedFamilySet(policy);
  const aBoosted = boosted.has(a.family) ? 1 : 0;
  const bBoosted = boosted.has(b.family) ? 1 : 0;
  return bBoosted - aBoosted;
}

function sortCardsForHand(a, b, policy = null) {
  const emphasisDelta = (EMPHASIS_PRIORITY[a.emphasis] ?? 1) - (EMPHASIS_PRIORITY[b.emphasis] ?? 1);
  if (emphasisDelta !== 0) return emphasisDelta;
  const boostedDelta = focusDelta(a, b, policy);
  if (boostedDelta !== 0) return boostedDelta;
  const priorityDelta = catalogPriority(b) - catalogPriority(a);
  if (priorityDelta !== 0) return priorityDelta;
  return String(a.id || '').localeCompare(String(b.id || ''));
}

function forcedFamilyOrder(values = []) {
  const order = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const family = String(value || '').trim();
    if (family && !order.has(family)) order.set(family, order.size);
  }
  return order;
}

function forcedFamilyOmission(family) {
  const cleanFamily = String(family || '').trim();
  if (!cleanFamily) return null;
  return {
    cardId: `manual-forced-${safeId(cleanFamily)}`,
    family: cleanFamily,
    reason: 'manual-forced-provider-failed',
    tokenEstimate: 0
  };
}

function effectiveMaxCardsForPolicy(maxCards, policy) {
  const base = numberInRange(maxCards, 6, 0, 64);
  if (!policy) return base;
  const ceiling = numberInRange(policy.cardBudget?.maxCards, base, 0, 64);
  let next = Math.min(base, ceiling);
  if (policy.strength?.selectionPressure === 'lean' && next > 0) next = Math.max(1, next - 1);
  return next;
}

function normalizeDeckCard(card, { preserveId = false } = {}) {
  const normalized = normalizeCard(card, {
    sceneId: card?.sceneId,
    snapshotHash: card?.source?.snapshotHash || card?.source?.fingerprint || card?.freshness?.sourceFingerprint || card?.sourceFingerprint,
    sourceRevisionHash: card?.source?.sourceRevisionHash || card?.freshness?.sourceRevisionHash || card?.sourceRevisionHash
  });
  if (preserveId && typeof card?.id === 'string' && card.id) normalized.id = card.id;
  return normalized;
}

export function normalizeCard(input = {}, context = {}) {
  const source = asObject(input);
  const ctx = asObject(context);
  const catalog = resolveCatalog(source);
  const promptText = cleanText(source.promptText ?? source.text ?? source.claim, CARD_TEXT_LIMIT);
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
      snapshotHash: normalizedSource.snapshotHash,
      sourceRevisionHash: normalizedSource.sourceRevisionHash
    },
    promptText,
    summary: cleanText(source.summary || promptText, SUMMARY_LIMIT),
    evidenceRefs: normalizeEvidenceRefs(source.evidenceRefs ?? source.evidence),
    tokenEstimate: numberInRange(source.tokenEstimate ?? source.tokenCost, estimateTokens(promptText), 1, MAX_TOKEN_ESTIMATE),
    detailProfile: validEnum(source.detailProfile, DETAIL, 'standard'),
    emphasis: validEnum(source.emphasis, EMPHASIS, 'normal'),
    origin: optionalEnum(source.origin, ORIGIN),
    freshness: {
      generatedAt: String(freshness.generatedAt ?? source.generatedAt ?? nowIso()),
      sourceFingerprint: String(normalizedSource.snapshotHash || freshness.sourceFingerprint || ''),
      sourceRevisionHash: String(normalizedSource.sourceRevisionHash || freshness.sourceRevisionHash || ''),
      expiresAfterMesId
    },
    arbiter: {
      lastDecisionId: String(arbiter.lastDecisionId ?? source.decisionId ?? ctx.decisionId ?? ''),
      reason: cleanText(arbiter.reason ?? source.reason ?? '', ARBITER_REASON_LIMIT)
    }
  };
  if (!card.origin) delete card.origin;
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
      const reason = cleanProviderPromptText(source.reason ?? '', ARBITER_REASON_LIMIT);
      const refreshOfCardId = cleanProviderPromptText(source.refreshOfCardId ?? source.replacesCardId ?? '', 160);
      const sourceSnapshotHash = String(context.snapshotHash ?? source.snapshotHash ?? '');
      const promptSnapshotHash = cleanProviderPromptText(sourceSnapshotHash, TEXT_LIMIT);
      const selectedSubItems = Array.isArray(context.cardScope?.selectedSubItemsByFamily?.[catalog.family])
        ? context.cardScope.selectedSubItemsByFamily[catalog.family].map((item) => String(item))
        : [];
      const storyForm = normalizeStoryForm(context.storyForm || UNKNOWN_STORY_FORM);
      return {
        roleId: catalog.role,
        runId: cleanProviderPromptText(context.runId ?? source.runId ?? '', TEXT_LIMIT),
        snapshotHash: promptSnapshotHash,
        cardScope: {
          family: catalog.family,
          selectedSubItems
        },
        storyForm,
        prompt: [
          `Create one compact ${catalog.family} card for the current scene.`,
          cardScopePromptBlock(catalog, selectedSubItems),
          storyFormPromptBlock(storyForm),
          refreshOfCardId ? `Refreshes cached card: ${refreshOfCardId}` : '',
          'Return one JSON object only. Do not wrap it in markdown.',
          'The JSON object must use schema "recursion.card.v1" and an "items" array with one card object.',
          `Envelope role must be "${catalog.role}".`,
          `Envelope family must be "${catalog.family}".`,
          promptSnapshotHash ? `Envelope snapshotHash must be "${promptSnapshotHash}".` : '',
          'The card object may contain promptText, summary, evidenceRefs, tokenEstimate, detailProfile, emphasis, and inspectorNotes.',
          'The card object must include at least one evidenceRefs entry containing a message:N reference.',
          'promptText is the only prompt-facing card text. inspectorNotes are private diagnostics for the Recursion inspector.',
          cardPromptSafetyInstruction(catalog),
          reason ? `Arbiter request reason: ${reason}` : '',
          `Snapshot hash: ${promptSnapshotHash}`,
          `Snapshot:\n${stringifyForPrompt(context.snapshot ?? {})}`
        ].filter(Boolean).join('\n\n'),
        metadata: {
          family: catalog.family,
          role: catalog.role,
          catalogKey: safeId(catalog.family),
          priority: catalog.priority,
          reason,
          ...(refreshOfCardId ? { refreshOfCardId } : {}),
          storyForm: {
            tense: storyForm.tense,
            pov: storyForm.pov,
            confidence: storyForm.confidence
          }
        }
      };
    })
    .filter(Boolean);
}

export function buildFusedCardBundleRequest(plan = {}, context = {}) {
  const cardScope = asObject(context.cardScope);
  const storyForm = normalizeStoryForm(context.storyForm || plan.storyForm || UNKNOWN_STORY_FORM);
  const snapshotHash = cleanProviderPromptText(context.snapshotHash ?? plan.snapshotHash ?? '', TEXT_LIMIT);
  const cardJobs = Array.isArray(plan?.cardJobs) ? plan.cardJobs : [];
  const requestedCards = buildCardRequests(plan, { ...context, storyForm }).map((request) => {
    const job = cardJobs.find((entry) => {
      const source = asObject(entry);
      return String(source.family || '').trim() === request.metadata.family
        || String(source.role || source.roleId || '').trim() === request.metadata.role;
    });
    return {
      family: request.metadata.family,
      role: request.metadata.role,
      priority: request.metadata.priority,
      reason: request.metadata.reason || '',
      selectedSubItems: Array.isArray(request.cardScope?.selectedSubItems) ? request.cardScope.selectedSubItems : [],
      refreshOfCardId: request.metadata.refreshOfCardId || '',
      forcedBy: String(asObject(job).forcedBy || '').trim()
    };
  });
  if (!requestedCards.length) return null;

  const requestBlocks = requestedCards.map((card, index) => {
    const catalog = resolveCatalog({ family: card.family, role: card.role }, { strict: true });
    return [
      `Requested card ${index + 1}:`,
      `- family: ${catalog.family}`,
      `- role: ${catalog.role}`,
      `- catalog priority: ${catalog.priority}`,
      card.reason ? `- Arbiter reason: ${card.reason}` : '- Arbiter reason: none provided',
      card.refreshOfCardId ? `- Refreshes cached card: ${card.refreshOfCardId}` : '- Refreshes cached card: none',
      card.forcedBy ? `- Forced by: ${card.forcedBy}` : '- Forced by: none',
      cardScopePromptBlock(catalog, card.selectedSubItems),
      cardPromptSafetyInstruction(catalog)
    ].filter(Boolean).join('\n');
  });

  return {
    roleId: 'fusedCardBundle',
    runId: cleanProviderPromptText(context.runId ?? plan.runId ?? '', TEXT_LIMIT),
    snapshotHash,
    cardScope,
    storyForm,
    requestedCards,
    prompt: [
      'Generate all requested Recursion scene cards in one structured card bundle.',
      'Return one JSON object only. Do not wrap it in markdown.',
      `The JSON object must use schema "${CARD_BUNDLE_RESPONSE_SCHEMA}".`,
      snapshotHash ? `Top-level snapshotHash must be "${snapshotHash}".` : '',
      'Top-level items must be an array. Each item is one card object for one requested family.',
      `Each item must include schema "${CARD_RESPONSE_SCHEMA}", family, role, promptText, and evidenceRefs.`,
      'Return at most one item per requested family. Do not generate unrequested families.',
      'If a requested card cannot be safely generated, omit it from items and add an omitted entry with family, role, and reason.',
      'promptText is the only prompt-facing card text. inspectorNotes are private diagnostics for the Recursion inspector.',
      storyFormPromptBlock(storyForm),
      requestBlocks.join('\n\n'),
      `Snapshot hash: ${snapshotHash}`,
      `Snapshot:\n${stringifyForPrompt(context.snapshot ?? {})}`
    ].filter(Boolean).join('\n\n'),
    metadata: {
      requestedCount: requestedCards.length,
      requestedFamilies: requestedCards.map((card) => card.family)
    }
  };
}

export function cardsFromProviderResult(result, context = {}) {
  if (!result?.ok) return [];
  const data = asObject(result.data);
  if (data.schema !== CARD_RESPONSE_SCHEMA) return [];
  const items = Array.isArray(data.items)
    ? data.items
    : (Array.isArray(data.cards) ? data.cards : []);
  if (items.length !== 1) return [];
  const catalog = resolveProviderEnvelopeCatalog(data, context);
  if (!catalog) return [];
  if (!providerSnapshotMatches(data, context)) return [];
  return items.flatMap((item) => {
    const source = asObject(item);
    if (!itemMatchesProviderCatalog(source, catalog)) return [];
    const evidenceRefs = repairProviderEvidenceRefs(source.evidenceRefs ?? source.evidence, context);
    if (!hasValidMessageEvidenceRefs(evidenceRefs, context)) return [];
    try {
      return [normalizeCard({
        ...source,
        role: catalog.role,
        family: catalog.family,
        promptText: source.promptText ?? source.text ?? source.claim,
        evidenceRefs,
        tokenEstimate: source.tokenEstimate ?? source.tokenCost,
        inspectorNotes: source.inspectorNotes
      }, context)];
    } catch {
      return [];
    }
  });
}

export function cardsFromFusedProviderResult(result, context = {}) {
  const output = {
    cards: [],
    omissions: [],
    diagnostics: [],
    acceptedFamilies: [],
    invalidFamilies: [],
    rejectedFamilies: [],
    missingFamilies: []
  };
  const finalize = () => {
    for (const key of ['acceptedFamilies', 'invalidFamilies', 'rejectedFamilies', 'missingFamilies']) {
      output[key] = [...new Set(output[key])];
    }
    return output;
  };
  if (!result?.ok) {
    output.diagnostics.push('fused-bundle-provider-failed');
    return finalize();
  }
  const data = asObject(result.data);
  if (data.schema !== CARD_BUNDLE_RESPONSE_SCHEMA) {
    output.diagnostics.push('fused-bundle-schema-mismatch');
    return finalize();
  }
  if (!providerSnapshotMatches(data, context)) {
    output.diagnostics.push('fused-bundle-snapshot-mismatch');
    return finalize();
  }
  const requested = new Map((Array.isArray(context.requestedCards) ? context.requestedCards : [])
    .map((card) => {
      const catalog = resolveCatalog({ family: card?.family, role: card?.role ?? card?.roleId }, { strict: false });
      return catalog ? [catalog.family, catalog] : null;
    })
    .filter(Boolean));
  const seen = new Set();
  const encounteredRequested = new Set();
  const items = Array.isArray(data.items) ? data.items : [];
  for (const rawItem of items) {
    const item = asObject(rawItem);
    const catalog = resolveCatalog({ family: item.family, role: item.role ?? item.roleId }, { strict: false });
    const diagnosticName = cleanOptionalText(item.family || item.role || item.roleId || 'unknown', 80) || 'unknown';
    if (!catalog || !requested.has(catalog.family) || seen.has(catalog.family)) {
      if (catalog?.family) output.rejectedFamilies.push(catalog.family);
      output.diagnostics.push(`fused-item-rejected:${diagnosticName}`);
      continue;
    }
    encounteredRequested.add(catalog.family);
    const cards = cardsFromProviderResult({
      ok: true,
      data: {
        schema: CARD_RESPONSE_SCHEMA,
        snapshotHash: data.snapshotHash,
        family: catalog.family,
        role: catalog.role,
        items: [item]
      }
    }, {
      ...context,
      expectedFamily: catalog.family,
      expectedRole: catalog.role
    });
    if (!cards.length) {
      output.invalidFamilies.push(catalog.family);
      const rejectReason = providerCardRejectReason({
        ok: true,
        data: {
          schema: CARD_RESPONSE_SCHEMA,
          snapshotHash: data.snapshotHash,
          family: catalog.family,
          role: catalog.role,
          items: [item]
        }
      }, {
        ...context,
        expectedFamily: catalog.family,
        expectedRole: catalog.role
      });
      output.diagnostics.push(`fused-item-invalid:${catalog.family}${rejectReason ? `:${rejectReason}` : ''}`);
      continue;
    }
    seen.add(catalog.family);
    output.acceptedFamilies.push(catalog.family);
    output.cards.push(...cards.map((card) => ({
      ...card,
      providerRole: 'fusedCardBundle',
      providerLane: result.lane || context.providerLane || 'utility',
      fusedBundleId: result.diagnostics?.runId || result.diagnostics?.requestHash || ''
    })));
  }
  for (const omission of Array.isArray(data.omitted) ? data.omitted : []) {
    const family = cleanOptionalText(omission?.family || '', 120);
    const role = cleanOptionalText(omission?.role || omission?.roleId || '', 120);
    const reason = cleanOptionalText(omission?.reason || 'provider-skipped', 120);
    if (family || role) output.omissions.push({ family, role, reason });
  }
  for (const family of requested.keys()) {
    if (!encounteredRequested.has(family)) {
      output.missingFamilies.push(family);
      output.diagnostics.push(`fused-item-missing:${family}`);
    }
  }
  return finalize();
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

export function selectHand(cards = [], { maxCards = 6, maxTokens = 700, behaviorPolicy = null, forcedFamilies = [] } = {}) {
  const policy = behaviorPolicyForHand(behaviorPolicy);
  const requestedCardLimit = numberInRange(maxCards, 6, 0, 64);
  const forcedOrder = forcedFamilyOrder(forcedFamilies);
  const cardLimit = Math.max(effectiveMaxCardsForPolicy(requestedCardLimit, policy), forcedOrder.size);
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
  const sortedCards = active.slice().sort((a, b) => {
    const aForced = forcedOrder.has(a.family);
    const bForced = forcedOrder.has(b.family);
    if (aForced !== bForced) return aForced ? -1 : 1;
    if (aForced && bForced) return forcedOrder.get(a.family) - forcedOrder.get(b.family);
    return sortCardsForHand(a, b, policy);
  });
  for (const card of sortedCards) {
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
    tokenEstimate += cardTokens;
    selected.push(sanitizeHandCard({
      ...card,
      tokenEstimate: cardTokens
    }));
  }

  const activeFamilies = new Set(active.map((card) => String(card.family || '').trim()).filter(Boolean));
  for (const family of forcedOrder.keys()) {
    if (!activeFamilies.has(family)) {
      const omission = forcedFamilyOmission(family);
      if (omission) omitted.push(omission);
    }
  }

  const behaviorPolicyMetadata = policy
    ? {
        ...summarizeBehaviorPolicyForDiagnostics(policy, {
          effectiveFootprint: policy.footprint?.level,
          selectedFamilies: selected.map((card) => card.family),
          planShaping: [
            policy.focus?.level && policy.focus.level !== 'balanced' ? 'focus-family-ordering' : '',
            policy.strength?.selectionPressure === 'lean' ? 'light-selection-pressure' : '',
            policy.cardBudget?.maxCards && policy.cardBudget.maxCards < requestedCardLimit ? 'card-budget-ceiling' : ''
          ]
        }),
        effectiveMaxCards: cardLimit
      }
    : null;
  return {
    handId: makeId('hand'),
    cards: selected,
    omitted,
    tokenEstimate,
    composedAt: nowIso(),
    metadata: {
      maxCards: cardLimit,
      requestedMaxCards: requestedCardLimit,
      maxTokens: tokenLimit,
      selectedCount: selected.length,
      omittedCount: omitted.length,
      forcedFamilies: [...forcedOrder.keys()],
      selectedForcedFamilies: selected.map((card) => card.family).filter((family) => forcedOrder.has(family)),
      tokenBudgetExceeded: tokenLimit > 0 && tokenEstimate > tokenLimit,
      sourceCardCount: Array.isArray(cards) ? cards.length : 0,
      ...(behaviorPolicyMetadata ? { behaviorPolicy: behaviorPolicyMetadata } : {})
    }
  };
}
