// Only complete, narrowly specified protective clauses are exempt. Do not
// exempt arbitrary text merely because its prefix is a prohibition.
const SUBJECT = String.raw`(?:(?:all|any|the|their|his|her)\s+)?(?:(?:hidden|private|secret|undisclosed)\s+)?(?:(?:internal|character)\s+)?(?:unrevealed\s+facts?|out-of-character\s+analysis|thoughts?|motives?|motivations?|intentions?|(?:future[-\s]+)?(?:plans?|plot|story)|spoilers?|chain[-\s]of[-\s]thought)`;
const OBJECTS = SUBJECT + String.raw`(?:\s*(?:,\s*(?:(?:and|or)\s+)?|(?:and|or)\s+)` + SUBJECT + ')*';
const PROTECTIVE = [
  new RegExp(String.raw`^(?:do not|don't|never)\s+(?:reveal|expose|disclose|invent|assert|confirm|print|show|describe)\s+` + OBJECTS + String.raw`(?:\s+(?:to\s+(?:the\s+)?(?:reader|player)|in\s+(?:the\s+)?(?:narration|story|response)))?$`, 'i'),
  new RegExp(String.raw`^avoid\s+(?:revealing|exposing|disclosing|inventing|asserting|confirming|printing|showing|describing)\s+` + OBJECTS + String.raw`(?:\s+(?:to\s+(?:the\s+)?(?:reader|player)|in\s+(?:the\s+)?(?:narration|story|response)))?$`, 'i'),
  new RegExp(String.raw`^(?:do not|don't|never)\s+treat\s+` + OBJECTS + String.raw`\s+as\s+(?:known|established|proven|certain)(?:\s+facts?)?$`, 'i'),
  new RegExp('^withhold\\s+' + OBJECTS + '$', 'i'),
  new RegExp('^keep\\s+' + OBJECTS + String.raw`\s+(?:private|hidden|unrevealed|uncertain|unknown|out\s+of\s+(?:the\s+)?(?:narration|story|response))$`, 'i')
];
function protectiveClause(clause) {
  return PROTECTIVE.some(pattern => pattern.test(clause));
}

export function unsafeInstructionMatch(text, patterns) {
  const clauses = String(text || '')
    .replace(/^\s*[-*]\s*\[[^\]\n]+\]\s*/gm, '')
    .split(/[.!?;\n]+/);
  for (let clause of clauses) {
    clause = clause.trim().replace(/^[-*]\s*/, '');
    if (protectiveClause(clause)) continue;
    for (const pattern of patterns) {
      const match = clause.match(pattern);
      if (match) return match[0].slice(0, 80);
    }
  }
  return '';
}

export const GUIDANCE_FORBIDDEN_PATTERNS = Object.freeze([
  /\bhidden\s+chain[-\s]of[-\s]thought\b/i,
  /\bchain[-\s]of[-\s]thought\b/i,
  /\b(hidden|private|secret|undisclosed)\s+(internal\s+)?thoughts?\b/i,
  /\b(private|hidden|secret|undisclosed)\s+(character\s+)?motives?\b/i,
  /\b(secret|hidden|private|undisclosed)\s+future[-\s]+(plans?|plot|story)\b/i,
  /\breveal\s+future\s+plans?\b/i,
  /\b(hidden|private|secret|undisclosed)\s+spoilers?\b/i,
  /\breveal\s+spoilers?\b/i
]);

// Export only known matcher vocabulary, never a rejected response or arbitrary field.
export function sanitizeGuidanceValidationDetails(details) {
  if (!Array.isArray(details)) return [];
  const entry = details.find(entry => entry?.field === 'guidanceText' && entry?.rule === 'hidden-content'
    && typeof entry.match === 'string' && entry.match.length <= 80
    && unsafeInstructionMatch(entry.match, GUIDANCE_FORBIDDEN_PATTERNS) === entry.match);
  return entry ? [{ field: 'guidanceText', rule: 'hidden-content', match: entry.match.toLowerCase().replace(/\s+/g, ' ') }] : [];
}
