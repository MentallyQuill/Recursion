import { jsonrepair } from '../vendor/jsonrepair/index.js';

export const STRUCTURED_OUTPUT_PARSE_ERROR_CODES = Object.freeze({
  JSON_INVALID: 'json_invalid',
  JSON_AMBIGUOUS: 'json_ambiguous',
  JSON_SIZE_LIMIT: 'json_size_limit',
  JSON_DEPTH_LIMIT: 'json_depth_limit',
  JSON_ITEM_LIMIT: 'json_item_limit',
  JSON_NOT_OBJECT: 'json_not_object',
  EMPTY_JSON: 'json_empty'
});

export const STRUCTURED_OUTPUT_LIMITS = Object.freeze({ maxCharacters: 262144, maxDepth: 64, maxBundleItems: 40 });

function parseFailure(code, message, length) {
  return { ok: false, error: message,
    diagnostic: createDiagnostic(code, message, { visibleContentLength: length }) };
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compactText(value = '', maxLength = 1000) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function createDiagnostic(code, message, details = {}) {
  return {
    ...(isObject(details) ? details : {}),
    code,
    message: compactText(message || 'Provider response was not valid JSON.', 1000)
  };
}

function scanStructure(source = '') {
  const stack = [];
  const roots = [];
  const arrays = [];
  let duplicateKeys = false;
  let duplicateRootKeys = false;
  function finishArrayMember(frame, end) {
    const member = source.slice(frame.memberStart, end).trim();
    if (member) {
      try { JSON.parse(member); frame.completeCount += 1; } catch { /* Invalid scalar is not a complete JSON member. */ }
    }
    frame.memberStart = end + 1;
  }
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '/' && source[index + 1] === '/') {
      index += 2;
      while (index < source.length && !/[\r\n]/.test(source[index])) index += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index += 1;
      continue;
    }
    if (char === '"') {
      const start = index;
      for (index += 1; index < source.length; index += 1) {
        if (source[index] === '\\') { index += 1; continue; }
        if (source[index] === '"') break;
      }
      const object = stack.at(-1);
      if (object?.type === '[') object.expectMember = false;
      let next = index + 1;
      while (/\s/.test(source[next] || '')) next += 1;
      if (object?.keys && source[next] === ':') {
        let key;
        try { key = JSON.parse(source.slice(start, index + 1)); } catch { continue; }
        if (object.keys.has(key)) {
          duplicateKeys = true;
          if (stack.length === 1) duplicateRootKeys = true;
        }
        object.keys.add(key);
        object.pendingKey = key;
      }
      continue;
    }
    if (char === '{' || char === '[') {
      if (!stack.length) roots.push({ start: index, type: char, end: -1 });
      const parent = stack.at(-1);
      const frame = { type: char, start: index, keys: char === '{' ? new Set() : null, members: [],
        expectMember: char === '[', directMember: parent?.type === '[' && parent.expectMember === true,
        memberStart: index + 1, completeCount: 0 };
      if (parent?.type === '[') parent.expectMember = false;
      if (char === '[' && stack.length === 1 && parent?.keys) {
        frame.propertyName = parent.pendingKey;
        arrays.push(frame);
      }
      if (parent?.keys) parent.pendingKey = null;
      stack.push(frame);
      if (stack.length > STRUCTURED_OUTPUT_LIMITS.maxDepth) return { duplicateKeys, duplicateRootKeys, roots, arrays, depthExceeded: true };
    } else if (char === '}' || char === ']') {
      if (stack.length) {
        const frame = stack.pop();
        if (frame.type === '[' && char === ']') finishArrayMember(frame, index);
        if ((char === '}' && frame.type !== '{') || (char === ']' && frame.type !== '[')) {
          return { duplicateKeys, duplicateRootKeys, roots, arrays, invalidBoundary: true };
        }
        if (stack.at(-1)?.type === '[' && frame.directMember) stack.at(-1).members.push({ start: frame.start, end: index + 1, type: frame.type });
        if (!stack.length) roots.at(-1).end = index + 1;
      }
    } else if (stack.at(-1)?.type === '[' && !/\s/.test(char)) {
      if (char === ',') finishArrayMember(stack.at(-1), index);
      stack.at(-1).expectMember = char === ',';
    }
  }
  return { duplicateKeys, duplicateRootKeys, roots, arrays };
}

function objectRootCount(structure, source) {
  return structure.roots.filter((root) => {
    if (root.type === '{') return true;
    if (root.end < 0) return false;
    try {
      const value = JSON.parse(source.slice(root.start, root.end));
      return Array.isArray(value) && value.length === 1 && isObject(value[0]);
    } catch { return false; }
  }).length;
}

export function stripReasoningBlocks(text = '') {
  return String(text || '')
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<reasoning\b[^>]*>[\s\S]*?<\/reasoning>/gi, '')
    .trim();
}

export function stripMarkdownFence(text = '') {
  const clean = stripReasoningBlocks(text).trim();
  const fenced = clean.match(/^```(?:json|text|markdown)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1] : clean).trim();
}

export function extractBalancedJsonObject(text = '') {
  const clean = stripMarkdownFence(text);
  const root = scanStructure(clean).roots.find((candidate) => candidate.type === '{');
  return root ? clean.slice(root.start, root.end < 0 ? undefined : root.end).trim() : '';
}

function escapeLiteralLineBreaksInStrings(text = '') {
  const source = String(text || '');
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      output += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      output += char;
      inString = !inString;
      continue;
    }
    if (inString && char === '\n') {
      output += '\\n';
      continue;
    }
    if (inString && char === '\r') {
      output += '\\r';
      continue;
    }
    output += char;
  }
  return output;
}

function removeJsonComments(text = '') {
  const source = String(text || '');
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1] || '';
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      output += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      output += char;
      inString = !inString;
      continue;
    }
    if (!inString && char === '/' && next === '/') {
      index += 2;
      while (index < source.length && !/[\n\r]/.test(source[index] || '')) index += 1;
      if (index < source.length) output += source[index];
      continue;
    }
    if (!inString && char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index += 1;
      continue;
    }
    output += char;
  }
  return output;
}

function removeTrailingCommas(text = '') {
  const source = String(text || '');
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      output += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      output += char;
      inString = !inString;
      continue;
    }
    if (!inString && char === ',') {
      let next = index + 1;
      while (/\s/.test(source[next] || '')) next += 1;
      if (source[next] === '}' || source[next] === ']') continue;
    }
    output += char;
  }
  return output;
}

function normalizeQuoteDelimiters(text = '') {
  let output = '';
  let closingQuote = '';
  let normalizedQuote = '';
  let escaped = false;
  for (const char of String(text || '')) {
    if (escaped) {
      output += char;
      escaped = false;
    } else if (closingQuote && char === '\\') {
      output += char;
      escaped = true;
    } else if (closingQuote) {
      if (char === closingQuote) {
        output += normalizedQuote;
        closingQuote = '';
      } else output += char;
    } else if (['"', "'", '\u201c', '\u201d', '\u2018', '\u2019'].includes(char)) {
      closingQuote = char === '\u201c' ? '\u201d' : char === '\u2018' ? '\u2019' : char;
      normalizedQuote = ['\u201c', '\u201d'].includes(char) ? '"'
        : ['\u2018', '\u2019'].includes(char) ? "'" : char;
      output += normalizedQuote;
    } else output += char;
  }
  return output;
}

export function repairCommonJson(text = '') {
  return escapeLiteralLineBreaksInStrings(removeTrailingCommas(removeJsonComments(normalizeQuoteDelimiters(String(text || '')
    .replace(/^\uFEFF/, '').trim())))).trim();
}

function uniqueCandidates(values = []) {
  const seen = new Set();
  return values
    .map((entry) => ({
      value: String(entry?.value || '').trim(),
      repairKind: String(entry?.repairKind || '')
    }))
    .filter((entry) => {
      if (!entry.value || seen.has(entry.value)) return false;
      seen.add(entry.value);
      return true;
    });
}

function repairWithJsonRepair(text = '') {
  const source = String(text || '').trim();
  if (!source.startsWith('{') || !source.endsWith('}')) return '';
  try {
    return jsonrepair(source);
  } catch {
    return '';
  }
}

function decodeEscapedTransportLineBreaks(text = '') {
  const source = String(text || '').trim();
  if (!/\\(?:r\\n|n|r)/.test(source)) return '';
  return source
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .trim();
}

export function parseStructuredJsonText(text = '', options = {}) {
  const input = String(text || '');
  if (input.length > STRUCTURED_OUTPUT_LIMITS.maxCharacters) {
    return parseFailure(STRUCTURED_OUTPUT_PARSE_ERROR_CODES.JSON_SIZE_LIMIT,
      'Provider structured output exceeds the character limit.', input.length);
  }
  const source = input.trim();
  if (!source) {
    return {
      ok: false,
      error: 'Provider returned empty structured output.',
      diagnostic: createDiagnostic(STRUCTURED_OUTPUT_PARSE_ERROR_CODES.EMPTY_JSON, 'Provider returned empty structured output.', {
        visibleContentLength: 0
      })
    };
  }

  const stripped = stripMarkdownFence(source);
  const scanSource = repairCommonJson(stripped);
  const structure = scanStructure(scanSource);
  if (structure.depthExceeded) return parseFailure(STRUCTURED_OUTPUT_PARSE_ERROR_CODES.JSON_DEPTH_LIMIT,
    'Provider structured output exceeds the nesting limit.', source.length);
  if (structure.arrays.some((array) => array.propertyName === 'items' && Math.max(array.members.length, array.completeCount) > STRUCTURED_OUTPUT_LIMITS.maxBundleItems)) {
    return parseFailure(STRUCTURED_OUTPUT_PARSE_ERROR_CODES.JSON_ITEM_LIMIT,
      'Provider bundle exceeds the complete-item limit.', source.length);
  }
  if (structure.duplicateKeys || objectRootCount(structure, scanSource) > 1) {
    return { ok: false, error: 'Provider output contains competing JSON values or duplicate object keys.',
      diagnostic: createDiagnostic(STRUCTURED_OUTPUT_PARSE_ERROR_CODES.JSON_AMBIGUOUS,
        'Provider output contains competing JSON values or duplicate object keys.', { visibleContentLength: source.length }) };
  }
  if (structure.roots.some((root) => root.end < 0)) return parseFailure(
    STRUCTURED_OUTPUT_PARSE_ERROR_CODES.JSON_INVALID,
    'Provider structured output contains an unfinished JSON value.', source.length);
  const balanced = extractBalancedJsonObject(source);
  const transportDecoded = decodeEscapedTransportLineBreaks(source);
  const transportDecodedStripped = stripMarkdownFence(transportDecoded);
  const transportDecodedBalanced = extractBalancedJsonObject(transportDecoded);
  const candidates = uniqueCandidates([
    { value: stripped },
    { value: balanced },
    { value: repairCommonJson(balanced), repairKind: 'common-json-repair' },
    { value: repairCommonJson(stripped), repairKind: 'common-json-repair' },
    { value: repairWithJsonRepair(balanced), repairKind: 'local-json-repair' },
    { value: transportDecodedStripped, repairKind: 'escaped-transport-line-breaks' },
    { value: transportDecodedBalanced, repairKind: 'escaped-transport-line-breaks' },
    { value: repairCommonJson(transportDecodedBalanced), repairKind: 'escaped-transport-line-breaks' },
    { value: repairCommonJson(transportDecodedStripped), repairKind: 'escaped-transport-line-breaks' },
    { value: repairWithJsonRepair(transportDecodedBalanced), repairKind: 'escaped-transport-line-breaks' }
  ]);
  let parsedNonObject = false;

  for (const candidateEntry of candidates) {
    const candidate = candidateEntry.value;
    if (scanStructure(candidate).duplicateKeys) {
      return { ok: false, error: 'Provider output contains duplicate object keys.',
        diagnostic: createDiagnostic(STRUCTURED_OUTPUT_PARSE_ERROR_CODES.JSON_AMBIGUOUS,
          'Provider output contains duplicate object keys.', { visibleContentLength: source.length }) };
    }
    try {
      let parsed = JSON.parse(candidate);
      let repairKind = candidateEntry.repairKind;
      if (options.requireObject !== false && Array.isArray(parsed) && parsed.length === 1 && isObject(parsed[0])) {
        parsed = parsed[0];
        repairKind = repairKind || 'singleton-array-normalization';
      }
      if (Array.isArray(parsed?.items) && parsed.items.length > STRUCTURED_OUTPUT_LIMITS.maxBundleItems) {
        return parseFailure(STRUCTURED_OUTPUT_PARSE_ERROR_CODES.JSON_ITEM_LIMIT,
          'Provider bundle exceeds the complete-item limit.', source.length);
      }
      if (options.requireObject !== false && !isObject(parsed)) {
        parsedNonObject = true;
        continue;
      }
      return {
        ok: true,
        value: parsed,
        repaired: Boolean(repairKind),
        repairKind,
        candidate,
        visibleContentLength: source.length
      };
    } catch { /* Try only the bounded, complete alternatives. */ }
  }

  if (parsedNonObject) {
    return {
      ok: false,
      error: 'Provider structured output must be an object.',
      diagnostic: createDiagnostic(STRUCTURED_OUTPUT_PARSE_ERROR_CODES.JSON_NOT_OBJECT, 'Provider structured output must be an object.', {
        visibleContentLength: source.length
      })
    };
  }
  return {
    ok: false,
    error: 'Provider response was not valid JSON.',
    diagnostic: createDiagnostic(STRUCTURED_OUTPUT_PARSE_ERROR_CODES.JSON_INVALID, 'Provider response was not valid JSON.', {
      visibleContentLength: source.length
    })
  };
}

export function extractJsonObjectsFromArrayProperty(text = '', propertyName = 'items') {
  const input = String(text || '');
  if (input.length > STRUCTURED_OUTPUT_LIMITS.maxCharacters) return [];
  const source = repairCommonJson(stripMarkdownFence(input));
  const structure = scanStructure(source);
  if (structure.depthExceeded || structure.invalidBoundary || structure.duplicateRootKeys
    || objectRootCount(structure, source) !== 1) return [];
  const array = structure.arrays.find((entry) => entry.propertyName === String(propertyName || 'items'));
  if (!array || Math.max(array.members.length, array.completeCount) > STRUCTURED_OUTPUT_LIMITS.maxBundleItems) return [];
  return array.members.filter((member) => member.type === '{').flatMap((member) => {
    const parsed = parseStructuredJsonText(source.slice(member.start, member.end), { requireObject: true });
    return parsed.ok ? [parsed.value] : [];
  });
}
