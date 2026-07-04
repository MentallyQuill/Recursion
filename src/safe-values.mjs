import { redact, truncate } from './core.mjs';

export function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function safeText(value, limit = 200) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return truncate(value.trim(), limit);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return truncate(JSON.stringify(redact(value, { maxString: limit })), limit);
  } catch {
    return '';
  }
}

export function unsafeObjectString(value) {
  const text = String(value || '');
  return text === '[object Object]' || text === 'object-Object';
}

export function safeDiagnosticText(value, limit = 500) {
  const text = safeText(value, limit);
  return unsafeObjectString(text) ? '' : text;
}

export function safeIdentifier(value, fallback = 'item') {
  const text = safeText(value, 80)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return text || fallback;
}
