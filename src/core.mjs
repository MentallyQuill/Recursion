const SECRET_KEY_SUFFIXES = [
  'apikey',
  'authorization',
  'cookie',
  'token',
  'password',
  'secret',
  'sessionkey',
  'bearer',
  'privatekey',
  'credentials',
  'authheader'
];
const FORBIDDEN_DIAGNOSTIC_KEY_PARTS = [
  'rawprompt',
  'rawresponse',
  'providerprompt',
  'providerresponse',
  'hiddenreasoning',
  'privatestoryplan',
  'privateplan',
  'sessionid'
];
const FORBIDDEN_DIAGNOSTIC_KEY_SUFFIXES = new Set(['body', 'data', 'payload', 'text', 'value']);
const PROVIDER_REASONING_DIAGNOSTIC_KEYS = new Set([
  'reasoning',
  'reasoningcontent',
  'reasoningdetails'
]);

function normalizeKey(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9]+/g, '').toLowerCase();
}

function isSecretKey(value) {
  const key = normalizeKey(value);
  if (!key || key.endsWith('count')) return false;
  if (PROVIDER_REASONING_DIAGNOSTIC_KEYS.has(key)) return true;
  if (isForbiddenDiagnosticKey(key)) return true;
  return SECRET_KEY_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

function isForbiddenDiagnosticKey(key) {
  for (const part of FORBIDDEN_DIAGNOSTIC_KEY_PARTS) {
    let index = key.indexOf(part);
    while (index >= 0) {
      const suffix = key.slice(index + part.length);
      if (!suffix || FORBIDDEN_DIAGNOSTIC_KEY_SUFFIXES.has(suffix)) return true;
      index = key.indexOf(part, index + part.length);
    }
  }
  return false;
}

function sanitizeId(value) {
  return String(value ?? '').trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

export function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function compact(value, limit = 10000) {
  return truncate(String(value ?? '').replace(/\s+/g, ' ').trim(), limit);
}

export function truncate(value, limit = 200) {
  const text = String(value ?? '');
  const numericLimit = Number(limit);
  const cap = numericLimit === Infinity ? text.length : Math.max(0, Math.floor(numericLimit) || 0);
  if (text.length <= cap) return text;
  if (cap <= 3) return '.'.repeat(cap);
  return `${text.slice(0, cap - 3)}...`;
}

export function safeId(value, fallback = 'item') {
  return sanitizeId(value) || sanitizeId(fallback) || 'item';
}

export function stableStringify(value) {
  const visiting = new WeakSet();
  function normalize(input) {
    if (!input || typeof input !== 'object') return input;
    if (visiting.has(input)) return '[Circular]';
    visiting.add(input);
    try {
      if (Array.isArray(input)) return input.map((entry) => normalize(entry));
      return Object.fromEntries(Object.keys(input).sort().map((key) => [key, normalize(input[key])]));
    } finally {
      visiting.delete(input);
    }
  }
  return JSON.stringify(normalize(value));
}

export function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (const char of String(value ?? '')) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function hashJson(value) {
  return fnv1a(stableStringify(value));
}

function stripFencedJson(text) {
  const source = String(text ?? '').trim();
  const match = source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : source;
}

function extractJsonObjectCandidate(text) {
  const source = String(text ?? '').trim();
  const start = source.indexOf('{');
  if (start < 0) return source;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1).trim();
    }
  }
  return source;
}

function normalizeJsonText(text) {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
}

function removeJsonLineComments(text) {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n' && text[index] !== '\r') index += 1;
      output += text[index] || '';
      continue;
    }
    output += char;
  }
  return output;
}

function removeTrailingJsonCommas(text) {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === ',') {
      let nextIndex = index + 1;
      while (/\s/.test(text[nextIndex] || '')) nextIndex += 1;
      if (text[nextIndex] === '}' || text[nextIndex] === ']') continue;
    }
    output += char;
  }
  return output;
}

function escapeLiteralStringLineBreaks(text) {
  let output = '';
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) {
        output += char;
        escaped = false;
      } else if (char === '\\') {
        output += char;
        escaped = true;
      } else if (char === '"') {
        output += char;
        inString = false;
      } else if (char === '\n') {
        output += '\\n';
      } else if (char === '\r') {
        output += '';
      } else {
        output += char;
      }
      continue;
    }
    output += char;
    if (char === '"') inString = true;
  }
  return output;
}

export function repairCommonJson(text) {
  return removeTrailingJsonCommas(
    escapeLiteralStringLineBreaks(
      removeJsonLineComments(
        normalizeJsonText(text)
      )
    )
  ).trim();
}

export function parseJsonObjectWithDiagnostics(value) {
  const source = extractJsonObjectCandidate(stripFencedJson(value));
  const visibleContentLength = source.length;
  let parsed;
  let repaired = false;
  let repairCode = '';
  try {
    parsed = JSON.parse(source);
  } catch (firstError) {
    const repairedSource = repairCommonJson(source);
    if (repairedSource !== source) {
      try {
        parsed = JSON.parse(repairedSource);
        repaired = true;
        repairCode = 'json_repaired';
      } catch {
        const wrapped = new Error(`Provider output is not valid JSON object: ${firstError.message}`);
        wrapped.code = 'RECURSION_JSON_PARSE_FAILED';
        throw wrapped;
      }
    } else {
      const wrapped = new Error(`Provider output is not valid JSON object: ${firstError.message}`);
      wrapped.code = 'RECURSION_JSON_PARSE_FAILED';
      throw wrapped;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = new Error('Provider output is not a valid JSON object.');
    error.code = 'RECURSION_JSON_OBJECT_REQUIRED';
    throw error;
  }
  return {
    value: parsed,
    repaired,
    repairCode,
    visibleContentLength
  };
}

export function parseJsonObject(value) {
  return parseJsonObjectWithDiagnostics(value).value;
}

export function redact(value, { maxString = 500 } = {}) {
  const visiting = new WeakSet();
  function visit(input, key = '') {
    if (isSecretKey(key)) return '[redacted]';
    if (typeof input === 'string') return truncate(input, maxString);
    if (!input || typeof input !== 'object') return input;
    if (visiting.has(input)) return '[Circular]';
    visiting.add(input);
    try {
      if (Array.isArray(input)) return input.map((entry) => visit(entry));
      return Object.fromEntries(Object.entries(input).map(([childKey, child]) => [childKey, visit(child, childKey)]));
    } finally {
      visiting.delete(input);
    }
  }
  return visit(value);
}

export function nowIso() {
  return new Date().toISOString();
}

export function makeId(prefix = 'id') {
  return `${safeId(prefix)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function assertObject(value, label = 'value') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label || 'value'} must be an object`);
  }
  return value;
}

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}
