const RULE_MESSAGES = Object.freeze({ type: 'Use the required field type.',
  required: 'Include this required field.', additionalProperties: 'Remove fields outside the requested contract.',
  const: 'Use the identity supplied by the request.', enum: 'Use one of the allowed request values.',
  minLength: 'Provide text within the required minimum length.', maxLength: 'Shorten text to the allowed length.',
  minimum: 'Use a number within the allowed lower bound.', maximum: 'Use a number within the allowed upper bound.',
  minItems: 'Include the required number of array items.', maxItems: 'Reduce the array to the allowed number of items.',
  uniqueItems: 'Remove duplicate array items.', anyOf: 'Use one of the requested field shapes.' });

function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

function equalJson(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((child, i) => equalJson(child, right[i]));
  if (isObject(left) && isObject(right)) return Object.keys(left).length === Object.keys(right).length
    && Object.keys(left).every((key) => Object.hasOwn(right, key) && equalJson(left[key], right[key]));
  return false;
}

const SCHEMA_KEYS = new Set(['type', 'const', 'enum', 'required', 'properties', 'additionalProperties', 'items',
  'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'anyOf']);
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
function assertSupportedSchema(schema) {
  if (!isObject(schema)) throw new TypeError('Output contract must be a schema object.');
  for (const key of Object.keys(schema)) if (!SCHEMA_KEYS.has(key)) throw new TypeError(`Unsupported output schema keyword: ${key}`);
  if (schema.type && !SCHEMA_TYPES.has(schema.type)) throw new TypeError('Unsupported output schema type.');
  for (const child of Object.values(schema.properties || {})) assertSupportedSchema(child);
  if (schema.items) assertSupportedSchema(schema.items);
  for (const branch of schema.anyOf || []) assertSupportedSchema(branch);
  if (isObject(schema.additionalProperties)) assertSupportedSchema(schema.additionalProperties);
}

export function normalizeOutputIssues(issues = [], { maxIssues = 8 } = {}) {
  const limit = Math.max(0, Math.min(8, Number.isFinite(maxIssues) ? Math.trunc(maxIssues) : 8));
  return (Array.isArray(issues) ? issues : []).filter((issue) => Object.hasOwn(RULE_MESSAGES, issue?.rule))
    .slice(0, limit).map((issue) => ({
      path: /^[A-Za-z0-9_$.[\]-]*$/.test(String(issue.path || '')) ? String(issue.path || '$').slice(0, 160) : '$',
      rule: issue.rule, message: RULE_MESSAGES[issue.rule]
    }));
}

export function validateOutputShape(value, schema, { maxIssues = 8 } = {}) {
  assertSupportedSchema(schema);
  const issues = [];
  function visit(current, contract, path = '') {
    if (!isObject(contract)) throw new TypeError('Output contract must be a schema object.');
    const typeMatches = !contract.type || ({
      object: isObject(current), array: Array.isArray(current), string: typeof current === 'string',
      number: typeof current === 'number' && Number.isFinite(current), integer: Number.isInteger(current),
      boolean: typeof current === 'boolean', null: current === null
    })[contract.type];
    if (!typeMatches) { issues.push({ path, rule: 'type' }); return; }
    if (Object.hasOwn(contract, 'const') && !equalJson(current, contract.const)) issues.push({ path, rule: 'const' });
    if (contract.enum && !contract.enum.some((allowed) => equalJson(current, allowed))) issues.push({ path, rule: 'enum' });
    if (contract.anyOf && !contract.anyOf.some((branch) => validateOutputShape(current, branch, { maxIssues: 0 }).ok)) {
      issues.push({ path, rule: 'anyOf' });
    }
    if (typeof current === 'string') {
      const length = [...current].length;
      if (length < contract.minLength) issues.push({ path, rule: 'minLength' });
      if (length > contract.maxLength) issues.push({ path, rule: 'maxLength' });
    }
    if (typeof current === 'number') {
      if (current < contract.minimum) issues.push({ path, rule: 'minimum' });
      if (current > contract.maximum) issues.push({ path, rule: 'maximum' });
    }
    if (Array.isArray(current)) {
      if (current.length < contract.minItems) issues.push({ path, rule: 'minItems' });
      if (current.length > contract.maxItems) issues.push({ path, rule: 'maxItems' });
      if (contract.uniqueItems && current.some((item, index) => current.slice(0, index).some((other) => equalJson(item, other)))) {
        issues.push({ path, rule: 'uniqueItems' });
      }
    }
    if (isObject(current)) {
      const properties = contract.properties || {};
      for (const key of contract.required || []) {
        if (!Object.hasOwn(current, key)) issues.push({ path: path ? `${path}.${key}` : key, rule: 'required' });
      }
      if (contract.additionalProperties === false && Object.keys(current).some((key) => !Object.hasOwn(properties, key))) {
        issues.push({ path, rule: 'additionalProperties' });
      }
      if (isObject(contract.additionalProperties)) {
        for (const [key, child] of Object.entries(current)) {
          if (!Object.hasOwn(properties, key)) visit(child, contract.additionalProperties, path);
        }
      }
      for (const [key, child] of Object.entries(properties)) {
        if (Object.hasOwn(current, key)) visit(current[key], child, path ? `${path}.${key}` : key);
      }
    }
    if (Array.isArray(current) && contract.items) current.forEach((item, index) => visit(item, contract.items, `${path}[${index}]`));
  }
  visit(value, schema);
  return { ok: issues.length === 0, issues: normalizeOutputIssues(issues, { maxIssues }) };
}
