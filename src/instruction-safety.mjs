// Only complete, narrowly specified protective clauses are exempt. Do not
// exempt arbitrary text merely because its prefix is a prohibition.
const SUBJECT = String.raw`(?:(?:all|any|the|their|his|her)\s+)?(?:(?:hidden|private|secret|undisclosed)\s+)?(?:(?:internal|character)\s+)?(?:thoughts?|motives?|motivations?|intentions?|(?:future\s+)?(?:plans?|plot|story)|spoilers?|chain[-\s]of[-\s]thought)`;
const OBJECTS = SUBJECT + String.raw`(?:\s*(?:,\s*(?:and\s+)?|and\s+)` + SUBJECT + ')*';
const PROTECTIVE = [
  new RegExp(String.raw`^(?:do not|don't|never)\s+(?:reveal|expose|disclose|invent|assert|confirm|print|show|describe)\s+` + OBJECTS + '$', 'i'),
  new RegExp(String.raw`^avoid\s+(?:revealing|exposing|disclosing|inventing|asserting|confirming|printing|showing|describing)\s+` + OBJECTS + '$', 'i'),
  new RegExp(String.raw`^(?:do not|don't|never)\s+treat\s+` + OBJECTS + String.raw`\s+as\s+(?:known|established|proven|certain)(?:\s+facts?)?$`, 'i'),
  new RegExp('^withhold\\s+' + OBJECTS + '$', 'i'),
  new RegExp('^keep\\s+' + OBJECTS + String.raw`\s+(?:private|hidden|unrevealed|uncertain|unknown)$`, 'i')
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
