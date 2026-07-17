import { jsonrepair } from '../vendor/jsonrepair/index.js';

export const STRUCTURED_OUTPUT_PARSE_ERROR_CODES = Object.freeze({
  JSON_INVALID: 'json_invalid',
  JSON_NOT_OBJECT: 'json_not_object',
  EMPTY_JSON: 'json_empty'
});

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
  const start = clean.indexOf('{');
  if (start < 0) return '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < clean.length; index += 1) {
    const char = clean[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return clean.slice(start, index + 1).trim();
    }
  }
  return clean.slice(start).trim();
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

export function repairCommonJson(text = '') {
  return escapeLiteralLineBreaksInStrings(removeTrailingCommas(removeJsonComments(String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .trim()))).trim();
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

export function parseStructuredJsonText(text = '', options = {}) {
  const source = String(text || '').trim();
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
  const balanced = extractBalancedJsonObject(source);
  const candidates = uniqueCandidates([
    { value: stripped },
    { value: balanced },
    { value: repairCommonJson(balanced), repairKind: 'common-json-repair' },
    { value: repairCommonJson(stripped), repairKind: 'common-json-repair' },
    { value: repairWithJsonRepair(balanced), repairKind: 'local-json-repair' }
  ]);
  let lastError = null;

  for (const candidateEntry of candidates) {
    const candidate = candidateEntry.value;
    try {
      const parsed = JSON.parse(candidate);
      if (options.requireObject !== false && !isObject(parsed)) {
        return {
          ok: false,
          error: 'Provider structured output must be an object.',
          diagnostic: createDiagnostic(STRUCTURED_OUTPUT_PARSE_ERROR_CODES.JSON_NOT_OBJECT, 'Provider structured output must be an object.', {
            visibleContentLength: source.length,
            sample: source.slice(0, 600)
          })
        };
      }
      return {
        ok: true,
        value: parsed,
        repaired: Boolean(candidateEntry.repairKind),
        repairKind: candidateEntry.repairKind,
        candidate,
        visibleContentLength: source.length
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    ok: false,
    error: lastError?.message || 'Provider response was not valid JSON.',
    diagnostic: createDiagnostic(STRUCTURED_OUTPUT_PARSE_ERROR_CODES.JSON_INVALID, lastError?.message || 'Provider response was not valid JSON.', {
      visibleContentLength: source.length,
      sample: source.slice(0, 600)
    })
  };
}

export function extractJsonObjectsFromArrayProperty(text = '', propertyName = 'items') {
  const source = String(text || '');
  const escapedPropertyName = String(propertyName || 'items').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const propertyPattern = new RegExp(`"${escapedPropertyName}"\\s*:\\s*\\[`, 'i');
  const match = propertyPattern.exec(source);
  if (!match) return [];
  let index = match.index + match[0].length;
  const values = [];
  while (index < source.length) {
    while (index < source.length && /[\s,]/.test(source[index] || '')) index += 1;
    if (source[index] === ']') break;
    if (source[index] !== '{') {
      index += 1;
      continue;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    const start = index;
    for (; index < source.length; index += 1) {
      const char = source[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\' && inString) {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === '{') depth += 1;
      if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          const parsed = parseStructuredJsonText(source.slice(start, index + 1), { requireObject: true });
          if (parsed.ok) values.push(parsed.value);
          index += 1;
          break;
        }
      }
    }
    if (depth !== 0) break;
  }
  return values;
}
