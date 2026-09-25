// Only complete, narrowly specified protective clauses are exempt. Do not
// exempt arbitrary text merely because its prefix is a prohibition.
const VALIDATION_RULES = new Set(['model-reasoning', 'character-interiority', 'unrevealed-story']);

export function normalizeInstructionValidationRule(value) {
  return VALIDATION_RULES.has(value) ? value : '';
}

const SUBJECT = String.raw`(?:(?:all|any|the|their|his|her)\s+)?(?:(?:hidden|private|secret|undisclosed)\s+)?(?:(?:internal|character)\s+)?(?:thoughts?|motives?|motivations?|intentions?|desires?|(?:future[-\s]+)?(?:plans?|plot|story)|spoilers?|chain[-\s]of[-\s]thought|unrevealed\s+facts?|out-of-character\s+analysis)`;
// Character references are bounded noun phrases, never arbitrary trailing prose.
const NAME_WORD = String.raw`(?!(?:and|or|but|then|unless|except|instead|until|when|whenever|if|once|after|before|without|save|provided|providing|assuming|should|as|only|reveal|expose|disclose|invent|assert|confirm|print|show|describe)\b)[a-z][a-z'-]*`;
const CHARACTER = String.raw`(?:for|of)\s+` + NAME_WORD + String.raw`(?:\s+` + NAME_WORD + '){0,3}';
const UNESTABLISHED = String.raw`(?:that|which)\s+(?:has|have)\s+not\s+been\s+established(?:\s+in\s+the\s+scene)?`;
const OBJECT = SUBJECT + '(?:\\s+' + CHARACTER + ')?(?:\\s+' + UNESTABLISHED + ')?';
const OBJECTS = OBJECT + String.raw`(?:\s*(?:,\s*(?:(?:and|or)\s+)?|(?:and|or)\s+)` + OBJECT + ')*';
const FACT = String.raw`(?:(?:known|established|proven|certain|confirmed|settled|objective)\s+)?(?:facts?|truth)`;
// Evidence guidance can distinguish an observation from an asserted private
// state. Keep both sides bounded; arbitrary prose here could hide a disclosure.
const OBSERVATION = String.raw`(?:subtext|interpretations?|inferences?|guidance)`;
const GROUNDED = String.raw`(?:scene-observable|observable|evidence-grounded|explicitly\s+inferred|deniable\s+when\s+uncertain)`;
const PROTECTIVE = [
  new RegExp(String.raw`^(?:do not|don't|never)\s+(?:reveal|expose|disclose|invent|assert|confirm|print|show|describe)\s+` + OBJECTS + String.raw`(?:\s+(?:to\s+(?:the\s+)?(?:reader|player)|in\s+(?:the\s+)?(?:narration|story|response)))?$`, 'i'),
  new RegExp(String.raw`^avoid\s+(?:revealing|exposing|disclosing|inventing|asserting|confirming|printing|showing|describing)\s+` + OBJECTS + String.raw`(?:\s+(?:to\s+(?:the\s+)?(?:reader|player)|in\s+(?:the\s+)?(?:narration|story|response)))?$`, 'i'),
  new RegExp(String.raw`^(?:do not|don't|never)\s+treat\s+` + OBJECTS + String.raw`\s+as\s+(?:known|established|proven|certain)(?:\s+facts?)?$`, 'i'),
  new RegExp(String.raw`^(?:avoid\s+(?:presenting|portraying|stating|framing|treating|depicting)|(?:do not|don't|never)\s+(?:present|portray|state|frame|treat|depict))\s+` + OBJECTS + String.raw`\s+as\s+` + FACT + '$', 'i'),
  new RegExp('^keep\\s+' + OBSERVATION + '\\s+' + GROUNDED + '(?:,\\s*' + GROUNDED + ')*' + String.raw`,?\s+and\s+separate\s+from\s+` + OBJECTS + String.raw`\s+as\s+` + FACT + '$', 'i'),
  new RegExp('^withhold\\s+' + OBJECTS + '$', 'i'),
  new RegExp('^keep\\s+' + OBJECTS + String.raw`\s+(?:private|hidden|unrevealed|uncertain|unknown|out\s+of\s+(?:the\s+)?(?:narration|story|response))$`, 'i')
];
function protectiveClause(clause) {
  return PROTECTIVE.some(pattern => pattern.test(clause));
}

export function unsafeInstructionMatch(text, patterns) {
  const clauses = String(text || '')
    .replace(/^[ \t]*[-*][ \t]*\[[^\]\n]+\][ \t]*(?:[-*+][ \t]*)?/gm, '- ')
    .replace(/^[ \t]*(?:[-*+\u2022][ \t]*|\d+[.)][ \t]+)/gm, '\u0000')
    // A new instruction starts a clause. Other line breaks remain whitespace,
    // so wrapping "hidden\nthoughts" cannot bypass the forbidden patterns and
    // a following "unless asked" cannot weaken a protective instruction.
    .split(/([.!?;]+|\r?\n(?=\u0000(?!(?:and|or|but|then|unless|except|instead|until|when|whenever|if|once|after|before|without|save|provided|providing|assuming|should|as|only|for|of|that|which)\b)|[ \t]*(?:do not|don't|never|avoid|withhold|keep|respond|answer|use|preserve|follow|treat|allow|respect|maintain|ground|let|focus|address|acknowledge|distinguish|recognize|leave|limit|reveal|expose|disclose|invent|assert|confirm|print|show|describe)\b))/i);
  // Retain separators when removing complete protective clauses. Checking the
  // remaining text together also catches forbidden phrases split across bullets.
  const unprotected = clauses.map((part) => {
    const clause = part.replace(/\u0000/g, '');
    return protectiveClause(clause.trim()) ? '' : clause;
  }).join('');
  for (const pattern of patterns) {
    const match = unprotected.match(pattern);
    if (match) return match[0].slice(0, 80);
  }
  return '';
}
