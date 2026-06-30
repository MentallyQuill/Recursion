import { inspect, isDeepStrictEqual } from 'node:util';

function formatValue(value) {
  return inspect(value, { breakLength: Infinity, depth: Infinity });
}

export function assert(condition, message = 'Assertion failed') {
  if (!condition) throw new Error(message);
}

export function assertEqual(actual, expected, message = 'Values are not equal') {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${formatValue(expected)}, got ${formatValue(actual)}`);
  }
}

export function assertDeepEqual(actual, expected, message = 'Objects are not equal') {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${message}: expected ${formatValue(expected)}, got ${formatValue(actual)}`);
  }
}

export async function assertRejects(fn, pattern, message = 'Expected rejection') {
  try {
    await fn();
  } catch (error) {
    const actual = String(error?.message || error);
    if (!pattern) return;
    if (pattern instanceof RegExp && pattern.test(actual)) return;
    if (typeof pattern === 'string' && actual.includes(pattern)) return;
    throw new Error(`${message}: ${error?.message || error}`);
  }
  throw new Error(message);
}
