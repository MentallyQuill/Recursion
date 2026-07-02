import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { redact, safeId } from '../../../src/core.mjs';

const DEFAULT_RECURSION_EXTENSION_PATH = '/scripts/extensions/third-party/Recursion';

const DEFAULT_USER_ALIASES = new Set([
  'default',
  'defaultprofile',
  'defaultuser',
  'defaultuserprofile',
  'user'
]);

const SOAK_USER_PATTERN = /^recursion-soak-[a-z0-9][a-z0-9_.-]{0,63}$/;

export function parseHarnessArgs(argv = []) {
  const args = new Set(argv);
  const liveRequested = args.has('--live');
  const dryRunRequested = args.has('--dry-run');
  return {
    live: liveRequested && !dryRunRequested,
    dryRun: !liveRequested || dryRunRequested,
    liveRequested,
    dryRunRequested,
    writeArtifacts: args.has('--write-artifacts'),
    strict: args.has('--strict')
  };
}

export function normalizeSoakUserHandle(value) {
  return String(value ?? '').trim().toLowerCase();
}

function compactUserAlias(handle) {
  return normalizeSoakUserHandle(handle).replace(/[^a-z0-9]+/g, '');
}

export function validateSoakUserHandle(value) {
  const user = normalizeSoakUserHandle(value);
  if (!user) {
    return {
      ok: false,
      status: 'unsafe-user',
      user,
      reason: 'missing-user'
    };
  }
  if (DEFAULT_USER_ALIASES.has(compactUserAlias(user))) {
    return {
      ok: false,
      status: 'unsafe-user',
      user,
      reason: 'default-profile-alias'
    };
  }
  if (!SOAK_USER_PATTERN.test(user)) {
    return {
      ok: false,
      status: 'unsafe-user',
      user,
      reason: 'non-dedicated-user'
    };
  }
  return {
    ok: true,
    status: 'pass',
    user,
    reason: 'dedicated-soak-user'
  };
}

export function rejectUnsafeLiveUser(value) {
  const result = validateSoakUserHandle(value);
  if (result.ok) return result;
  const error = new Error(`Unsafe SillyTavern live-test user: ${result.reason}`);
  error.code = 'unsafe-user';
  error.status = 'unsafe-user';
  error.details = result;
  throw error;
}

export function parseSoakUserList(value) {
  return String(value ?? '')
    .split(',')
    .map((entry) => normalizeSoakUserHandle(entry))
    .filter(Boolean);
}

export function validateSoakUserList(value) {
  const users = parseSoakUserList(value);
  const seen = new Set();
  const results = [];
  for (const user of users) {
    const result = validateSoakUserHandle(user);
    if (result.ok && seen.has(result.user)) {
      results.push({
        ...result,
        ok: false,
        status: 'unsafe-user',
        reason: 'duplicate-user'
      });
    } else {
      if (result.ok) seen.add(result.user);
      results.push(result);
    }
  }
  if (users.length === 0) {
    results.push(validateSoakUserHandle(''));
  }
  const failed = results.filter((entry) => !entry.ok);
  return {
    ok: failed.length === 0,
    status: failed.length === 0 ? 'pass' : 'unsafe-user',
    users: results.filter((entry) => entry.ok && entry.user).map((entry) => entry.user),
    results,
    failed
  };
}

export function createRunId(prefix = 'recursion-live') {
  return `${safeId(prefix)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function elapsedMs(startedAt) {
  const started = Date.parse(startedAt);
  return Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0;
}

const SENSITIVE_TEXT_PATTERNS = Object.freeze([
  [/\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Authorization: Bearer [redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  [/\bsk-[A-Za-z0-9][A-Za-z0-9._-]{5,}/gi, '[redacted]'],
  [/\b(api[-_ ]?key|password|secret|token|cookie|csrf|session[-_ ]?id|session|sid)\s*[:=]\s*['"]?[^'",;\s]+['"]?/gi, '$1=[redacted]']
]);

const ARTIFACT_TEXT_FILE_PATTERN = /\.(?:json|jsonl|md|txt)$/i;
const REDACTION_SCAN_SKIP_PATHS = new Set(['diagnostics/redaction-check.json']);
const FORBIDDEN_ARTIFACT_KEYS = new Set([
  'apikey',
  'authorization',
  'authheader',
  'bearer',
  'cookie',
  'credentials',
  'csrf',
  'password',
  'privatekey',
  'providerprompt',
  'providerresponse',
  'rawprompt',
  'rawresponse',
  'secret',
  'session',
  'sessionapikey',
  'sessionid',
  'sessionkey',
  'sid',
  'token'
]);
const FORBIDDEN_ARTIFACT_KEY_SUFFIXES = Object.freeze([
  'apikey',
  'authorization',
  'authheader',
  'bearer',
  'credentials',
  'csrf',
  'password',
  'privatekey',
  'providerprompt',
  'providerresponse',
  'rawprompt',
  'rawresponse',
  'secret',
  'session',
  'sessionapikey',
  'sessionid',
  'sessionkey',
  'sid',
  'token'
]);
const FORBIDDEN_ARTIFACT_KEY_CONTAINS = Object.freeze([
  'authorization',
  'bearer',
  'cookie'
]);
const FORBIDDEN_ARTIFACT_TEXT_PATTERNS = Object.freeze([
  /\bAuthorization\s*:\s*Bearer\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]+/i,
  /\bBearer\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]+/i,
  /\bsk-[A-Za-z0-9][A-Za-z0-9._-]{5,}/i,
  /\b(?:api[-_ ]?key|password|secret|token|cookie|csrf|session[-_ ]?id|sid)\s*[:=]\s*(?!\[redacted\])['"]?[^'",;\s]+['"]?/i,
  /\b(?:rawPrompt|rawResponse|providerPrompt|providerResponse)\b/i
]);

const HARNESS_SECRET_KEY_SUFFIXES = Object.freeze([
  'session',
  'sessionid',
  'sessionids',
  'sid'
]);

function sanitizeHarnessText(value, limit = 500) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of SENSITIVE_TEXT_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text;
}

function normalizeHarnessKey(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9]+/g, '').toLowerCase();
}

function isHarnessSecretKey(value) {
  const key = normalizeHarnessKey(value);
  if (!key || key.endsWith('count')) return false;
  return HARNESS_SECRET_KEY_SUFFIXES.some((suffix) => key === suffix || key.endsWith(suffix));
}

function redactHarnessValue(value) {
  const keyed = redact(value);
  const visiting = new WeakSet();
  function visit(input, key = '') {
    if (isHarnessSecretKey(key)) return '[redacted]';
    if (typeof input === 'string') return sanitizeHarnessText(input);
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
  return visit(keyed);
}

function encodeBase64Utf8(text) {
  return Buffer.from(String(text ?? ''), 'utf8').toString('base64');
}

function normalizeBaseUrl(value) {
  const source = String(value ?? '').trim();
  if (!source) {
    const error = new Error('SILLYTAVERN_BASE_URL is required.');
    error.status = 'environment-fail';
    error.result = 'missing-base-url';
    throw error;
  }
  try {
    const url = new URL(source);
    url.hash = '';
    url.search = '';
    return url.href.replace(/\/+$/, '');
  } catch {
    const error = new Error('SILLYTAVERN_BASE_URL must be a valid URL.');
    error.status = 'environment-fail';
    error.result = 'invalid-base-url';
    throw error;
  }
}

function normalizeExtensionPath(value = DEFAULT_RECURSION_EXTENSION_PATH) {
  const source = String(value || DEFAULT_RECURSION_EXTENSION_PATH).trim().replace(/\\/g, '/');
  const withSlash = source.startsWith('/') ? source : `/${source}`;
  return withSlash.replace(/\/+$/, '') || DEFAULT_RECURSION_EXTENSION_PATH;
}

function sha256Text(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

function fileSha256(filePath) {
  return sha256Text(readFileSync(filePath, 'utf8'));
}

function artifactTarget(artifactLocation, relativePath) {
  const safeRelativePath = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const target = join(artifactLocation.dir, safeRelativePath);
  mkdirSync(dirname(target), { recursive: true });
  return { relativePath: safeRelativePath, target };
}

function cookiePairsFromHeader(value) {
  if (!value) return [];
  return String(value)
    .split(/,(?=\s*[^;,=\s]+=[^;,]+)/)
    .map((entry) => entry.trim().split(';')[0])
    .filter((entry) => entry.includes('='));
}

function playwrightCookiesFromMap(cookieMap, baseUrl) {
  return [...cookieMap.entries()].map(([name, value]) => ({
    name,
    value,
    url: normalizeBaseUrl(baseUrl)
  }));
}

async function fetchHarnessText({
  baseUrl,
  requestPath,
  headers = {},
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000
} = {}) {
  if (typeof fetchImpl !== 'function') {
    const error = new Error('fetch is not available.');
    error.status = 'environment-fail';
    error.result = 'fetch-unavailable';
    throw error;
  }
  const root = normalizeBaseUrl(baseUrl);
  const path = String(requestPath || '').startsWith('/') ? String(requestPath || '') : `/${String(requestPath || '')}`;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller && Number(timeoutMs) > 0
    ? setTimeout(() => controller.abort(), Number(timeoutMs))
    : null;
  try {
    const response = await fetchImpl(`${root}${path}`, {
      method: 'GET',
      headers,
      signal: controller?.signal
    });
    const parsed = await parseResponseBody(response);
    return {
      ok: Boolean(response?.ok),
      status: Number(response?.status) || 0,
      text: parsed.text,
      json: parsed.json,
      byteLength: Buffer.byteLength(parsed.text || '', 'utf8')
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function responseSetCookies(response) {
  if (typeof response?.headers?.getSetCookie === 'function') {
    return response.headers.getSetCookie().flatMap((entry) => cookiePairsFromHeader(entry));
  }
  const header = typeof response?.headers?.get === 'function' ? response.headers.get('set-cookie') : null;
  return cookiePairsFromHeader(header);
}

async function parseResponseBody(response) {
  const text = typeof response?.text === 'function' ? await response.text() : '';
  if (!text) return { text: '', json: null };
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

function passwordEnvKey(user) {
  return `RECURSION_SILLYTAVERN_PASSWORD_${String(user).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function passwordForUser(user, env) {
  return env[passwordEnvKey(user)] ?? env.RECURSION_SILLYTAVERN_PASSWORD ?? '';
}

function storageProbeFileName(runId, user) {
  return `recursion-live-probe-${safeId(runId, 'run')}-${safeId(user, 'user')}.json`;
}

function createProbePayload({ runId, user }) {
  return {
    recordType: 'recursion.liveProbe',
    schemaVersion: 1,
    runId,
    owner: user,
    createdAt: nowIso()
  };
}

export function createSillyTavernHttpSession({ baseUrl, user, password = '', fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    const error = new Error('fetch is not available.');
    error.status = 'environment-fail';
    error.result = 'fetch-unavailable';
    throw error;
  }
  const root = normalizeBaseUrl(baseUrl);
  const cookies = new Map();
  let csrfToken = '';

  function applyCookies(response) {
    for (const pair of responseSetCookies(response)) {
      const [name, ...rest] = pair.split('=');
      if (name && rest.length) cookies.set(name.trim(), rest.join('=').trim());
    }
  }

  function currentCookieHeader() {
    return [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
  }

  async function request(path, { method = 'GET', body = null, csrf = false } = {}) {
    const headers = {};
    const cookie = currentCookieHeader();
    if (cookie) headers.Cookie = cookie;
    if (body !== null) headers['Content-Type'] = 'application/json';
    if (csrf && csrfToken) headers['X-CSRF-Token'] = csrfToken;
    const response = await fetchImpl(`${root}${path}`, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body)
    });
    applyCookies(response);
    const parsed = await parseResponseBody(response);
    return {
      ok: Boolean(response?.ok),
      status: Number(response?.status) || 0,
      json: parsed.json,
      text: parsed.text
    };
  }

  async function assertOk(response, action, result) {
    if (response.ok) return response;
    const error = new Error(`${action} failed with HTTP ${response.status}`);
    error.status = response.status === 403 || response.status === 401 ? 'environment-fail' : 'fail';
    error.result = result;
    error.httpStatus = response.status;
    throw error;
  }

  return {
    user,
    authHeaders() {
      const headers = {};
      const cookie = currentCookieHeader();
      if (cookie) headers.Cookie = cookie;
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
      return headers;
    },
    cookieHeader() {
      return currentCookieHeader();
    },
    playwrightCookies() {
      return playwrightCookiesFromMap(cookies, root);
    },
    async init() {
      const response = await request('/csrf-token');
      await assertOk(response, 'csrf-token', 'csrf-failed');
      csrfToken = String(response.json?.token || '');
      if (!csrfToken) {
        const error = new Error('CSRF token was missing.');
        error.status = 'environment-fail';
        error.result = 'csrf-missing';
        throw error;
      }
    },
    async login() {
      if (!csrfToken) await this.init();
      const response = await request('/api/users/login', {
        method: 'POST',
        csrf: true,
        body: { handle: user, password }
      });
      await assertOk(response, 'login', 'login-failed');
      return response.json;
    },
    async uploadJson(fileName, value) {
      const response = await request('/api/files/upload', {
        method: 'POST',
        csrf: true,
        body: { name: fileName, data: encodeBase64Utf8(JSON.stringify(value)) }
      });
      await assertOk(response, 'file-upload', 'file-upload-failed');
      return response.json;
    },
    async verify(paths) {
      const response = await request('/api/files/verify', {
        method: 'POST',
        csrf: true,
        body: { urls: paths }
      });
      await assertOk(response, 'file-verify', 'file-verify-failed');
      return response.json || {};
    },
    async readJson(fileName) {
      const response = await request(`/user/files/${encodeURIComponent(fileName)}`);
      await assertOk(response, 'file-read', 'file-read-failed');
      if (!response.json) {
        const error = new Error('Probe file did not contain JSON.');
        error.status = 'fail';
        error.result = 'file-read-invalid-json';
        throw error;
      }
      return response.json;
    },
    async deleteFile(fileName) {
      const response = await request('/api/files/delete', {
        method: 'POST',
        csrf: true,
        body: { path: `/user/files/${fileName}` }
      });
      if (response.status === 404) return { missing: true };
      await assertOk(response, 'file-delete', 'file-delete-failed');
      return { deleted: true };
    }
  };
}

async function runStorageProbeSuite({ baseUrl, users, env = {}, fetchImpl = globalThis.fetch, runId }) {
  const sessions = [];
  const probes = [];
  const cleanup = [];
  let outcome = null;

  async function cleanupProbes() {
    for (const probe of probes) {
      try {
        const result = await probe.session.deleteFile(probe.fileName);
        cleanup.push({ user: probe.user, fileName: probe.fileName, status: result.deleted ? 'deleted' : 'missing' });
      } catch (error) {
        cleanup.push({ user: probe.user, fileName: probe.fileName, status: 'failed', result: error?.result || 'cleanup-failed' });
      }
    }
  }

  try {
    for (const user of users) {
      const session = createSillyTavernHttpSession({
        baseUrl,
        user,
        password: passwordForUser(user, env),
        fetchImpl
      });
      await session.init();
      await session.login();
      sessions.push(session);
    }

    for (const session of sessions) {
      const user = session.user;
      const fileName = storageProbeFileName(runId, user);
      const payload = createProbePayload({ runId, user });
      await session.uploadJson(fileName, payload);
      probes.push({ user, fileName, path: `/user/files/${fileName}`, session, payload });
    }

    for (const probe of probes) {
      const verified = await probe.session.verify([probe.path]);
      if (verified[probe.path] !== true) {
        const error = new Error('Own storage probe did not verify.');
        error.status = 'fail';
        error.result = 'storage-probe-own-missing';
        throw error;
      }
      const readBack = await probe.session.readJson(probe.fileName);
      if (readBack?.recordType !== 'recursion.liveProbe' || readBack?.runId !== runId || readBack?.owner !== probe.user) {
        const error = new Error('Own storage probe readback did not match expected metadata.');
        error.status = 'fail';
        error.result = 'storage-probe-readback-mismatch';
        throw error;
      }
    }

    const isolationChecks = [];
    if (probes.length > 1) {
      for (const probe of probes) {
        const otherPaths = probes.filter((entry) => entry.user !== probe.user).map((entry) => entry.path);
        const verified = await probe.session.verify(otherPaths);
        for (const otherPath of otherPaths) {
          const isolated = verified[otherPath] !== true;
          isolationChecks.push({ user: probe.user, path: otherPath, isolated });
          if (!isolated) {
            const error = new Error('Cross-user storage probe was visible.');
            error.status = 'fail';
            error.result = 'storage-probe-isolation-failed';
            throw error;
          }
        }
      }
    }

    outcome = {
      status: 'pass',
      result: 'storage-probe-pass',
      users,
      probes: probes.map((probe) => ({ user: probe.user, fileName: probe.fileName, path: probe.path })),
      isolationChecks,
      warnings: probes.length > 1 ? [] : [{ name: 'single-user-probe', status: 'warn', summary: 'Only one soak user was configured; cross-user isolation was not evaluated.' }]
    };
  } catch (error) {
    outcome = {
      status: error?.status || 'environment-fail',
      result: error?.result || 'storage-probe-failed',
      users,
      probes: probes.map((probe) => ({ user: probe.user, fileName: probe.fileName, path: probe.path })),
      error: {
        name: error?.name,
        result: error?.result,
        httpStatus: error?.httpStatus
      }
    };
  } finally {
    await cleanupProbes();
    if (outcome?.status === 'pass' && cleanup.some((entry) => entry.status === 'failed')) {
      outcome.status = 'fail';
      outcome.result = 'storage-probe-cleanup-failed';
      outcome.error = {
        result: 'storage-probe-cleanup-failed'
      };
    }
    for (const session of sessions) {
      if (typeof session.close === 'function') await session.close();
    }
    if (outcome) outcome.cleanup = cleanup;
  }
  return outcome;
}

const STATIC_ESM_SPECIFIER_PATTERN = /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function normalizeRelativeFilePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
}

function relativePathInside(root, filePath) {
  const path = relative(root, filePath).replace(/\\/g, '/');
  if (!path || path === '..' || path.startsWith('../') || isAbsolute(path)) return null;
  return normalizeRelativeFilePath(path);
}

function readLocalUtf8(localRoot, relativePath) {
  return readFileSync(resolve(localRoot, normalizeRelativeFilePath(relativePath)), 'utf8');
}

function extractStaticImportSpecifiers(source) {
  const specifiers = [];
  STATIC_ESM_SPECIFIER_PATTERN.lastIndex = 0;
  for (const match of String(source || '').matchAll(STATIC_ESM_SPECIFIER_PATTERN)) {
    const specifier = String(match[1] || match[2] || '').trim();
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

function resolveLocalImportSpecifier({ localRoot, importerRelativePath, specifier }) {
  if (!String(specifier || '').startsWith('.')) return null;
  const root = resolve(localRoot);
  const importerDirectory = dirname(normalizeRelativeFilePath(importerRelativePath));
  const absoluteBase = resolve(root, importerDirectory, specifier);
  const candidates = [
    absoluteBase,
    `${absoluteBase}.mjs`,
    `${absoluteBase}.js`,
    resolve(absoluteBase, 'index.mjs'),
    resolve(absoluteBase, 'index.js')
  ];
  for (const candidate of candidates) {
    const relativeCandidate = relativePathInside(root, candidate);
    if (!relativeCandidate) continue;
    try {
      readLocalUtf8(root, relativeCandidate);
      return relativeCandidate;
    } catch {
      // Try the next ESM resolution candidate.
    }
  }
  return null;
}

function buildLocalStaticModuleGraph({ localRoot = process.cwd(), entryFiles = [] } = {}) {
  const root = resolve(localRoot);
  const queue = [];
  const seen = new Set();

  function enqueue(relativePath) {
    const normalized = normalizeRelativeFilePath(relativePath);
    if (!/\.(?:mjs|js)$/i.test(normalized) || seen.has(normalized)) return;
    seen.add(normalized);
    queue.push(normalized);
  }

  for (const entry of entryFiles) enqueue(entry);

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    let source = '';
    try {
      source = readLocalUtf8(root, current);
    } catch {
      continue;
    }
    for (const specifier of extractStaticImportSpecifiers(source)) {
      const resolved = resolveLocalImportSpecifier({ localRoot: root, importerRelativePath: current, specifier });
      if (resolved) enqueue(resolved);
    }
  }

  return [...seen];
}

async function compareServedRecursionExtension({
  baseUrl,
  extensionPath = DEFAULT_RECURSION_EXTENSION_PATH,
  localRoot = process.cwd(),
  headers = {},
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000
} = {}) {
  const normalizedExtensionPath = normalizeExtensionPath(extensionPath);
  const manifestPath = `${normalizedExtensionPath}/manifest.json`;
  const manifest = await fetchHarnessText({ baseUrl, requestPath: manifestPath, headers, fetchImpl, timeoutMs });
  const manifestFiles = [];
  if (manifest.ok && manifest.json && typeof manifest.json === 'object') {
    if (manifest.json.js) manifestFiles.push(String(manifest.json.js));
    if (manifest.json.css) manifestFiles.push(String(manifest.json.css));
  }
  const manifestScripts = manifestFiles.filter((file) => /\.(?:mjs|js)$/i.test(file));
  const manifestStyles = manifestFiles.filter((file) => /\.css$/i.test(file));
  const moduleGraph = buildLocalStaticModuleGraph({
    localRoot,
    entryFiles: [...manifestScripts, 'src/extension/index.js']
  });
  const files = [...new Set([
    'manifest.json',
    ...moduleGraph,
    ...manifestStyles,
    'styles/recursion.css'
  ])];

  const compared = [];
  for (const relativePath of files) {
    const localPath = resolve(localRoot, relativePath);
    const servedPath = `${normalizedExtensionPath}/${relativePath.replace(/\\/g, '/')}`;
    const record = {
      relativePath,
      servedPath,
      localExists: false,
      servedOk: false,
      status: null,
      localSha256: null,
      servedSha256: null,
      matches: null,
      byteLength: 0,
      error: null
    };

    try {
      record.localSha256 = fileSha256(localPath);
      record.localExists = true;
    } catch (error) {
      record.error = `local:${error?.code || error?.name || 'read-failed'}`;
    }

    try {
      const served = relativePath === 'manifest.json'
        ? manifest
        : await fetchHarnessText({ baseUrl, requestPath: servedPath, headers, fetchImpl, timeoutMs });
      record.status = served.status;
      record.servedOk = served.ok;
      record.byteLength = served.byteLength;
      if (served.ok) {
        record.servedSha256 = sha256Text(served.text || '');
        record.matches = record.localSha256 ? record.localSha256 === record.servedSha256 : null;
      } else {
        record.error = record.error || `served:HTTP ${served.status}`;
      }
    } catch (error) {
      record.error = record.error || `served:${error?.name || 'fetch-failed'}`;
    }
    compared.push(record);
  }

  const servedFailureCount = compared.filter((entry) => !entry.servedOk).length;
  const mismatchCount = compared.filter((entry) => entry.matches === false).length;
  const missingLocalCount = compared.filter((entry) => !entry.localExists).length;
  const servedStatus = servedFailureCount > 0 || !manifest.ok
    ? 'served-extension-unavailable'
    : mismatchCount > 0 || missingLocalCount > 0
    ? 'served-extension-mismatch'
    : 'served-extension-match';

  return {
    status: servedStatus === 'served-extension-match' ? 'pass' : servedStatus === 'served-extension-mismatch' ? 'stale-extension' : 'environment-fail',
    result: servedStatus,
    servedStatus,
    ok: servedStatus === 'served-extension-match',
    baseUrl: normalizeBaseUrl(baseUrl),
    extensionPath: normalizedExtensionPath,
    manifest: {
      ok: manifest.ok,
      status: manifest.status,
      key: manifest.json?.key || null,
      displayName: manifest.json?.display_name || null,
      js: manifest.json?.js || null,
      css: manifest.json?.css || null
    },
    compared,
    mismatchCount,
    missingLocalCount,
    servedFailureCount
  };
}

function compactBrowserIssue(error) {
  return {
    name: error?.name || 'Error',
    message: sanitizeHarnessText(error?.message || String(error || ''), 240),
    cause: error?.cause
      ? {
          name: error.cause?.name || 'Error',
          message: sanitizeHarnessText(error.cause?.message || String(error.cause || ''), 240)
        }
      : null
  };
}

function browserSnapshotScript() {
  return () => {
    const text = (selector) => String(document.querySelector(selector)?.textContent || '').replace(/\s+/g, ' ').trim();
    const visible = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return false;
      const style = globalThis.getComputedStyle ? getComputedStyle(element) : null;
      return style ? style.display !== 'none' && style.visibility !== 'hidden' : true;
    };
    const context = (() => {
      try {
        return globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || null;
      } catch {
        return null;
      }
    })();
    return {
      readyState: document.readyState,
      url: location.href,
      title: document.title,
      rootMounted: Boolean(document.querySelector('#recursion-root')),
      barVisible: visible('[data-recursion-bar]'),
      statusText: text('[data-recursion-status]'),
      modeText: text('[data-recursion-mode]'),
      handText: text('[data-recursion-hand-count]'),
      composerText: text('[data-recursion-composer]'),
      reasonerText: text('[data-recursion-reasoner]'),
      ribbonText: text('[data-recursion-ribbon-label]'),
      actionMenuOpen: document.querySelector('[data-recursion-action-menu]')?.hidden === false,
      progressOpen: document.querySelector('[data-recursion-status-popover]')?.hidden === false,
      handOpen: document.querySelector('[data-recursion-hand-dropdown]')?.hidden === false,
      settingsPanelOpen: document.querySelector('[data-recursion-settings-panel]')?.hidden === false,
      providerTestVisible: visible('[data-recursion-provider-test]'),
      viewerOpen: (() => {
        const viewer = document.querySelector('[data-recursion-viewer]');
        if (!viewer) return false;
        return viewer.tagName === 'DIALOG' ? viewer.open === true : viewer.hidden === false;
      })(),
      viewerOpened: globalThis.__recursionSmokeViewerOpened === true,
      modeSmoke: globalThis.__recursionSmokeModeSmoke || null,
      generation: globalThis.__recursionSmokeGeneration || null,
      bridge: {
        interceptor: typeof globalThis.recursionGenerationInterceptor === 'function',
        enableHook: typeof globalThis.recursionOnEnable === 'function',
        disableHook: typeof globalThis.recursionOnDisable === 'function'
      },
      sillyTavernContext: {
        available: Boolean(context),
        chatLength: Array.isArray(context?.chat) ? context.chat.length : null
      },
      recursionScripts: Array.from(document.scripts || [])
        .map((script) => script.src || script.id || '')
        .filter((value) => /Recursion|third-party\/Recursion|recursion/i.test(value))
        .slice(0, 12),
      recursionStyles: Array.from(document.querySelectorAll('link[rel="stylesheet"]') || [])
        .map((link) => link.href || link.id || '')
        .filter((value) => /Recursion|third-party\/Recursion|recursion/i.test(value))
        .slice(0, 12)
    };
  };
}

function modeSmokeSeedPromptScript() {
  return () => {
    const context = (() => {
      try {
        return globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || null;
      } catch {
        return null;
      }
    })();
    let seeded = false;
    let error = '';
    try {
      if (!context || typeof context.setExtensionPrompt !== 'function') {
        throw new Error('setExtensionPrompt unavailable for mode smoke');
      }
      context.setExtensionPrompt('recursion.sceneBrief', 'Recursion mode smoke baseline.', 'IN_PROMPT', 4, false, 'SYSTEM');
      seeded = true;
    } catch (seedError) {
      error = String(seedError?.message || seedError || 'mode smoke seed failed');
    }
    const promptKeys = Object.entries(context?.prompts || {})
      .filter(([key, value]) => String(key || '').startsWith('recursion.') && String(value?.text ?? value ?? '').length > 0)
      .map(([key]) => String(key))
      .slice(0, 24);
    return { seeded, promptKeys, error };
  };
}

function modeSmokeReadStepScript() {
  return (mode) => {
    const context = (() => {
      try {
        return globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || null;
      } catch {
        return null;
      }
    })();
    const statusText = String(document.querySelector('[data-recursion-status]')?.textContent || '').replace(/\s+/g, ' ').trim();
    const modeText = String(document.querySelector('[data-recursion-mode]')?.textContent || '').replace(/\s+/g, ' ').trim();
    const powerButton = document.querySelector('[data-recursion-power-toggle]');
    const powerPressed = powerButton ? powerButton.getAttribute('aria-pressed') !== 'false' : true;
    const selectedValue = String(document.querySelector('[data-recursion-setting-mode]')?.value || '').toLowerCase();
    const modeLower = modeText.toLowerCase();
    const observedMode = /manual/.test(modeLower)
      ? 'manual'
      : (/auto/.test(modeLower) ? 'auto' : 'unknown');
    const promptKeys = Object.entries(context?.prompts || {})
      .filter(([key, value]) => String(key || '').startsWith('recursion.') && String(value?.text ?? value ?? '').length > 0)
      .map(([key]) => String(key))
      .slice(0, 24);
    const expectedMode = mode === 'disabled' ? (selectedValue || observedMode) : mode;
    return {
      mode: String(mode || ''),
      selectedValue,
      observedMode,
      powerPressed,
      modeApplied: mode === 'disabled'
        ? powerPressed === false && promptKeys.length === 0
        : powerPressed === true && (!selectedValue || selectedValue === expectedMode) && observedMode === expectedMode,
      statusText,
      modeText,
      promptCleared: promptKeys.length === 0,
      promptKeys
    };
  };
}

function modeSmokeWaitScript() {
  return (mode) => {
    const context = (() => {
      try {
        return globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || null;
      } catch {
        return null;
      }
    })();
    const selectedValue = String(document.querySelector('[data-recursion-setting-mode]')?.value || '').toLowerCase();
    const modeText = String(document.querySelector('[data-recursion-mode]')?.textContent || '').toLowerCase();
    const powerButton = document.querySelector('[data-recursion-power-toggle]');
    const powerPressed = powerButton ? powerButton.getAttribute('aria-pressed') !== 'false' : true;
    const observedMode = /manual/.test(modeText)
      ? 'manual'
      : (/auto/.test(modeText) ? 'auto' : 'unknown');
    const promptKeys = Object.entries(context?.prompts || {})
      .filter(([key, value]) => String(key || '').startsWith('recursion.') && String(value?.text ?? value ?? '').length > 0)
      .map(([key]) => String(key));
    if (mode === 'disabled') return powerPressed === false && promptKeys.length === 0;
    return powerPressed === true && (!selectedValue || selectedValue === mode) && observedMode === mode;
  };
}

function manualScopeProofScript() {
  return (disabledFamily = 'Scene Frame') => {
    const family = String(disabledFamily || 'Scene Frame');
    const cardsButton = document.querySelector('[data-recursion-cards-button]');
    const cardsPanel = document.querySelector('[data-recursion-cards-panel]');
    const familyToggle = [...document.querySelectorAll('[data-recursion-card-scope-family-toggle]')]
      .find((node) => String(node?.dataset?.recursionCardScopeFamilyName || '') === family);
    if (!cardsButton || !cardsPanel || !familyToggle) {
      const proof = {
        requested: true,
        available: false,
        disabledFamily: family,
        disabled: false,
        label: '',
        error: 'card scope controls unavailable'
      };
      globalThis.__recursionSmokeManualScopeProof = proof;
      return proof;
    }
    if (cardsPanel.hidden) cardsButton.click();
    familyToggle.click();
    const label = String(document.querySelector('[data-recursion-cards-label]')?.textContent || '').replace(/\s+/g, ' ').trim();
    const proof = {
      requested: true,
      available: true,
      disabledFamily: family,
      disabled: label !== 'Cards',
      label,
      error: ''
    };
    globalThis.__recursionSmokeManualScopeProof = proof;
    return proof;
  };
}

function generationRecorderInstallScript() {
  return () => {
    const hashText = (value) => {
      let hash = 0x811c9dc5;
      for (const char of String(value || '')) {
        hash ^= char.codePointAt(0);
        hash = Math.imul(hash, 0x01000193);
      }
      return (hash >>> 0).toString(16).padStart(8, '0');
    };
    const context = (() => {
      try {
        return globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || null;
      } catch {
        return null;
      }
    })();
    if (!context || typeof context.setExtensionPrompt !== 'function') {
      globalThis.__recursionSmokePromptRecorder = {
        ok: false,
        reason: 'setExtensionPrompt-unavailable',
        events: []
      };
      return globalThis.__recursionSmokePromptRecorder;
    }
    if (!context.__recursionSmokeOriginalSetExtensionPrompt) {
      context.__recursionSmokeOriginalSetExtensionPrompt = context.setExtensionPrompt.bind(context);
    }
    context.__recursionSmokePromptEvents = [];
    context.setExtensionPrompt = (...args) => {
      const [key, text, position, depth, scan, role] = args;
      const promptKey = String(key || '');
      if (promptKey.startsWith('recursion.')) {
        const promptText = String(text || '');
        context.__recursionSmokePromptEvents.push({
          key: promptKey,
          textHash: hashText(promptText),
          textLength: promptText.length,
          cleared: promptText.length === 0,
          position: String(position ?? ''),
          depth: Number(depth) || 0,
          scan: Boolean(scan),
          role: String(role ?? '')
        });
      }
      return context.__recursionSmokeOriginalSetExtensionPrompt(...args);
    };
    globalThis.__recursionSmokePromptRecorder = {
      ok: true,
      reason: 'installed',
      events: context.__recursionSmokePromptEvents
    };
    return globalThis.__recursionSmokePromptRecorder;
  };
}

function generationManualProofScript() {
  return async () => {
    const context = (() => {
      try {
        return globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || null;
      } catch {
        return null;
      }
    })();
    const promptKeys = () => Object.entries(context?.prompts || {})
      .filter(([key, value]) => String(key || '').startsWith('recursion.') && String(value?.text ?? value ?? '').length > 0)
      .map(([key]) => String(key));
    const eventSlice = () => Array.isArray(context?.__recursionSmokePromptEvents)
      ? context.__recursionSmokePromptEvents.slice()
      : [];
    const observedMode = (() => {
      const modeText = String(document.querySelector('[data-recursion-mode]')?.textContent || '').toLowerCase();
      if (/manual/.test(modeText)) return 'manual';
      if (/auto/.test(modeText)) return 'auto';
      return 'unknown';
    })();
    const modeApplied = observedMode === 'manual';

    let disableHookOk = false;
    let interceptorOk = false;
    let error = '';
    try {
      if (typeof globalThis.recursionOnDisable !== 'function') {
        throw new Error('recursionOnDisable unavailable');
      }
      await globalThis.recursionOnDisable();
      disableHookOk = true;
      if (Array.isArray(context?.__recursionSmokePromptEvents)) context.__recursionSmokePromptEvents.length = 0;
    } catch (clearError) {
      error = String(clearError?.message || clearError || 'manual baseline clear failed');
    }

    const beforePromptKeys = promptKeys();
    const baselineClearOk = disableHookOk && beforePromptKeys.length === 0;
    const beforeEvents = eventSlice();
    try {
      if (typeof globalThis.recursionGenerationInterceptor !== 'function') {
        throw new Error('recursionGenerationInterceptor unavailable');
      }
      const chat = Array.isArray(context?.chat) ? context.chat.slice() : [];
      chat.push({
        mesid: chat.length,
        is_user: true,
        name: 'Recursion Smoke Manual',
        mes: 'Recursion live smoke: prove Manual installs prompts.'
      });
      await globalThis.recursionGenerationInterceptor(chat);
      interceptorOk = true;
    } catch (interceptorError) {
      error = String(interceptorError?.message || interceptorError || 'manual interceptor failed');
    }

    const afterEvents = eventSlice();
    const newEvents = afterEvents.slice(beforeEvents.length);
    const installedEvents = newEvents.filter((entry) => entry && entry.cleared === false && String(entry.key || '').startsWith('recursion.'));
    const afterPromptKeys = promptKeys();
    const addedPromptKeys = afterPromptKeys.filter((key) => !beforePromptKeys.includes(key));
    const promptInstalled = beforePromptKeys.length > 0 || installedEvents.length > 0 || addedPromptKeys.length > 0;
    const promptKeysForProof = [...new Set([
      ...beforePromptKeys,
      ...installedEvents.map((entry) => String(entry.key || '')),
      ...addedPromptKeys
    ])].filter(Boolean);
    if (!error && !modeApplied) error = 'manual mode was not applied';
    if (!error && !baselineClearOk) error = 'manual baseline prompt remained installed';
    if (!error && !promptInstalled) error = 'manual mode did not install prompt text';
    const proof = {
      requested: true,
      mode: 'manual',
      observedMode,
      modeApplied,
      ok: modeApplied && baselineClearOk && interceptorOk && promptInstalled,
      disableHookOk,
      baselineClearOk,
      interceptorOk,
      promptInstalled,
      promptKeys: promptKeysForProof,
      promptEventCount: newEvents.length,
      error
    };
    globalThis.__recursionSmokeManualProof = proof;
    globalThis.__recursionSmokeGeneration = {
      ...(globalThis.__recursionSmokeGeneration || {}),
      requested: true,
      manualProof: proof
    };
    return proof;
  };
}

const VISIBLE_SEND_INPUT_SELECTORS = Object.freeze([
  '#send_textarea',
  'textarea#send_textarea',
  'textarea[name="send_textarea"]',
  'textarea[aria-label*="message" i]',
  'textarea[placeholder*="message" i]',
  '[contenteditable="true"][aria-label*="message" i]',
  '[contenteditable="true"]'
]);

const VISIBLE_SEND_BUTTON_SELECTORS = Object.freeze([
  '#send_but',
  'button#send_but',
  'button[aria-label*="send" i]',
  'button[title*="send" i]',
  '[role="button"][aria-label*="send" i]'
]);

async function findFirstVisibleLocator(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      const visible = await candidate.isVisible().catch(() => false);
      if (visible) {
        const enabled = await candidate.isEnabled().catch(() => false);
        return { locator: candidate, selector, index, enabled };
      }
    }
  }
  return null;
}

async function resolveVisibleSendSurface(page) {
  const input = await findFirstVisibleLocator(page, VISIBLE_SEND_INPUT_SELECTORS);
  const button = await findFirstVisibleLocator(page, VISIBLE_SEND_BUTTON_SELECTORS);
  return {
    input,
    button,
    evidence: {
      inputFound: Boolean(input),
      buttonFound: Boolean(button),
      inputUsable: input?.enabled === true,
      buttonUsable: button?.enabled === true,
      inputSelector: input?.selector || '',
      buttonSelector: button?.selector || '',
      ok: false
    }
  };
}

async function fillVisibleSendInput(page, locator, text, timeoutMs) {
  try {
    await locator.fill(text, { timeout: timeoutMs });
    return 'fill';
  } catch (fillError) {
    await locator.click({ timeout: timeoutMs });
    await page.keyboard.insertText(text);
    return `keyboard-after-fill-error:${fillError?.name || 'Error'}`;
  }
}

function generationBaseSetupScript() {
  return ({ reasonerRequested: pageReasonerRequested, triggerSource, chatMutationSource, visibleSend }) => {
    const context = (() => {
      try {
        return globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || null;
      } catch {
        return null;
      }
    })();
    const chatLengthBefore = Array.isArray(context?.chat) ? context.chat.length : null;
    const smokeMessage = {
      mesid: typeof chatLengthBefore === 'number' ? chatLengthBefore : 0,
      is_user: true,
      name: 'Recursion Smoke',
      mes: pageReasonerRequested
        ? 'Recursion live smoke: exercise the Reasoner-capable prompt bridge safely.'
        : 'Recursion live smoke: exercise the Utility prompt bridge safely.'
    };
    const normalizedVisibleSend = {
      inputFound: visibleSend?.inputFound === true,
      buttonFound: visibleSend?.buttonFound === true,
      inputUsable: visibleSend?.inputUsable === true,
      buttonUsable: visibleSend?.buttonUsable === true,
      inputSelector: String(visibleSend?.inputSelector || ''),
      buttonSelector: String(visibleSend?.buttonSelector || ''),
      ok: false,
      chatLength: chatLengthBefore,
      messageLength: smokeMessage.mes.length
    };
    const hostGenerationEvidence = {
      chatLengthBefore,
      chatLengthAfter: chatLengthBefore,
      assistantMessageObserved: false,
      markerOk: false
    };
    const base = {
      requested: true,
      reasonerRequested: Boolean(pageReasonerRequested),
      manualProof: globalThis.__recursionSmokeManualProof || null,
      startedAt: new Date().toISOString(),
      triggerSource,
      chatMutationSource,
      visibleSend: normalizedVisibleSend,
      interceptorOk: false,
      interceptorError: '',
      promptRecorderOk: globalThis.__recursionSmokePromptRecorder?.ok === true,
      hostGenerationRequired: triggerSource === 'ui-send',
      hostGenerationContinued: triggerSource === 'ui-send' ? false : null,
      hostGenerationEvidence
    };
    globalThis.__recursionSmokeVisibleSend = null;
    globalThis.__recursionSmokeHostGeneration = null;
    globalThis.__recursionSmokeGenerationSmokeMessage = smokeMessage;
    globalThis.__recursionSmokeGenerationBase = base;
    globalThis.__recursionSmokeGeneration = base;
    return {
      base,
      smokeMessageText: smokeMessage.mes
    };
  };
}

function generationDirectBridgeScript() {
  return async () => {
    const context = (() => {
      try {
        return globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || null;
      } catch {
        return null;
      }
    })();
    const base = globalThis.__recursionSmokeGenerationBase || {};
    const smokeMessage = globalThis.__recursionSmokeGenerationSmokeMessage || {
      mesid: Array.isArray(context?.chat) ? context.chat.length : 0,
      is_user: true,
      name: 'Recursion Smoke',
      mes: base.reasonerRequested
        ? 'Recursion live smoke: exercise the Reasoner-capable prompt bridge safely.'
        : 'Recursion live smoke: exercise the Utility prompt bridge safely.'
    };
    try {
      if (Array.isArray(context?.chat)) context.chat.push(smokeMessage);
      if (typeof globalThis.recursionGenerationInterceptor !== 'function') {
        throw new Error('recursionGenerationInterceptor unavailable');
      }
      await globalThis.recursionGenerationInterceptor(context?.chat || [smokeMessage]);
      base.interceptorOk = true;
    } catch (error) {
      base.interceptorError = String(error?.message || error || 'Generation interceptor failed.');
    }
    const chatLengthAfter = Array.isArray(context?.chat) ? context.chat.length : null;
    base.visibleSend = {
      ...(base.visibleSend || {}),
      ok: false,
      chatLength: chatLengthAfter
    };
    base.hostGenerationRequired = false;
    base.hostGenerationContinued = null;
    base.hostGenerationEvidence = {
      ...(base.hostGenerationEvidence || {}),
      chatLengthAfter,
      assistantMessageObserved: false,
      markerOk: false
    };
    globalThis.__recursionSmokeGenerationBase = base;
    globalThis.__recursionSmokeGeneration = base;
    return base;
  };
}

function generationEvidenceScript() {
  return () => {
    const base = globalThis.__recursionSmokeGenerationBase || {};
    const context = (() => {
      try {
        return globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || null;
      } catch {
        return null;
      }
    })();
    const promptEvents = Array.isArray(context?.__recursionSmokePromptEvents)
      ? context.__recursionSmokePromptEvents.slice()
      : [];
    const handText = String(document.querySelector('[data-recursion-hand-count]')?.textContent || '');
    const statusText = String(document.querySelector('[data-recursion-status]')?.textContent || '');
    const modeText = String(document.querySelector('[data-recursion-mode]')?.textContent || '');
    const packetNode = document.querySelector('[data-recursion-prompt-packet]');
    const promptInstalled = promptEvents.some((entry) => entry && entry.cleared === false && String(entry.key || '').startsWith('recursion.'));
    const promptKeys = [...new Set(promptEvents
      .filter((entry) => entry && String(entry.key || '').startsWith('recursion.'))
      .map((entry) => String(entry.key)))];
    const packetText = String(packetNode?.textContent || '').trim();
    let packet = null;
    try {
      packet = packetText ? JSON.parse(packetText) : null;
    } catch {
      packet = null;
    }
    const packetId = String(packet?.packetId || '').trim();
    const handId = String(packet?.handId || '').trim();
    const selectedCardRefs = Array.isArray(packet?.selectedCardRefs) ? packet.selectedCardRefs : [];
    const normalizedSelectedCardRefs = selectedCardRefs.map((entry) => {
      if (entry && typeof entry === 'object') {
        return {
          id: String(entry.id || entry.cardId || '').trim(),
          family: String(entry.family || '').trim(),
          role: String(entry.role || '').trim()
        };
      }
      return { id: String(entry || '').trim(), family: '', role: '' };
    }).filter((entry) => entry.id || entry.family || entry.role);
    const manualScopeProof = base.manualScopeProof || globalThis.__recursionSmokeManualScopeProof || null;
    const disabledFamily = String(manualScopeProof?.disabledFamily || '');
    const selectedFamilies = normalizedSelectedCardRefs.map((entry) => entry.family).filter(Boolean);
    const disabledFamilyInstalled = Boolean(disabledFamily && selectedFamilies.includes(disabledFamily));
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const chatLengthBefore = typeof base.hostGenerationEvidence?.chatLengthBefore === 'number'
      ? base.hostGenerationEvidence.chatLengthBefore
      : (typeof base.visibleSend?.chatLength === 'number' ? base.visibleSend.chatLength : null);
    const chatLengthAfter = Array.isArray(context?.chat) ? context.chat.length : null;
    const newMessages = typeof chatLengthBefore === 'number' ? chat.slice(Math.max(0, chatLengthBefore)) : [];
    const assistantMessageObserved = newMessages.some((message) => message && message.is_user === false);
    const markerOk = globalThis.__recursionSmokeHostGeneration?.ok === true;
    const hostGenerationRequired = base.triggerSource === 'ui-send';
    const hostGenerationContinued = hostGenerationRequired
      ? Boolean(markerOk || assistantMessageObserved || (typeof chatLengthAfter === 'number' && typeof chatLengthBefore === 'number' && chatLengthAfter > chatLengthBefore + 1))
      : null;
    const promptPacketVisible = Boolean(packetId && handId && selectedCardRefs.length > 0);
    const visibleSend = {
      ...(base.visibleSend || {}),
      ok: base.triggerSource === 'ui-send'
        ? Boolean(base.visibleSend?.ok === true || (promptInstalled && typeof chatLengthAfter === 'number' && typeof chatLengthBefore === 'number' && chatLengthAfter > chatLengthBefore))
        : false,
      chatLength: typeof chatLengthAfter === 'number' ? chatLengthAfter : base.visibleSend?.chatLength ?? null
    };
    const generation = {
      ...base,
      requested: true,
      completedAt: new Date().toISOString(),
      interceptorOk: base.interceptorOk === true || promptInstalled || promptPacketVisible,
      interceptorError: String(base.interceptorError || ''),
      promptRecorderOk: base.promptRecorderOk === true,
      visibleSend,
      hostGenerationRequired,
      hostGenerationContinued,
      hostGenerationEvidence: {
        chatLengthBefore,
        chatLengthAfter,
        assistantMessageObserved,
        markerOk
      },
      promptInstalled,
      promptKeys,
      promptEventCount: promptEvents.length,
      promptEvents: promptEvents.slice(-12),
      handText,
      handReady: /\bHand\s+[1-9]\d*/i.test(handText),
      statusText,
      modeText,
      ready: /Ready/i.test(statusText),
      promptPacketVisible,
      manualProof: base.manualProof || globalThis.__recursionSmokeManualProof || null,
      manualScopeProof: manualScopeProof
        ? {
            requested: manualScopeProof.requested === true,
            available: manualScopeProof.available === true,
            disabledFamily,
            disabled: manualScopeProof.disabled === true,
            label: String(manualScopeProof.label || ''),
            hasFamilyMetadata: selectedFamilies.length > 0,
            disabledFamilyInstalled,
            promptRespectsDisabledFamily: selectedFamilies.length > 0 && disabledFamily ? disabledFamilyInstalled === false : null,
            error: String(manualScopeProof.error || '')
          }
        : null,
      promptPacket: packet
        ? {
            packetId,
            handId,
            selectedCardRefs: normalizedSelectedCardRefs.slice(0, 12),
            diagnostics: {
              composerLane: String(packet?.diagnostics?.composerLane || ''),
              reasonerStatus: String(packet?.diagnostics?.reasonerStatus || '')
            }
          }
        : null
    };
    globalThis.__recursionSmokeGeneration = generation;
    return generation;
  };
}

function generationHostContinuationReadyScript() {
  return () => {
    const base = globalThis.__recursionSmokeGenerationBase || {};
    if (base.triggerSource !== 'ui-send') return true;
    const context = (() => {
      try {
        return globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || null;
      } catch {
        return null;
      }
    })();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const chatLengthBefore = typeof base.hostGenerationEvidence?.chatLengthBefore === 'number'
      ? base.hostGenerationEvidence.chatLengthBefore
      : (typeof base.visibleSend?.chatLength === 'number' ? base.visibleSend.chatLength : null);
    const chatLengthAfter = Array.isArray(context?.chat) ? context.chat.length : null;
    const newMessages = typeof chatLengthBefore === 'number' ? chat.slice(Math.max(0, chatLengthBefore)) : [];
    const assistantMessageObserved = newMessages.some((message) => message && message.is_user === false);
    const markerOk = globalThis.__recursionSmokeHostGeneration?.ok === true;
    const hostGenerationContinued = Boolean(markerOk || assistantMessageObserved || (typeof chatLengthAfter === 'number' && typeof chatLengthBefore === 'number' && chatLengthAfter > chatLengthBefore + 1));
    const hostGenerationEvidence = {
      chatLengthBefore,
      chatLengthAfter,
      assistantMessageObserved,
      markerOk
    };
    globalThis.__recursionSmokeGenerationBase = {
      ...base,
      hostGenerationRequired: true,
      hostGenerationContinued,
      hostGenerationEvidence
    };
    globalThis.__recursionSmokeGeneration = {
      ...(globalThis.__recursionSmokeGeneration || {}),
      hostGenerationRequired: true,
      hostGenerationContinued,
      hostGenerationEvidence
    };
    return hostGenerationContinued;
  };
}

function generationPromptClearScript() {
  return async () => {
    const context = (() => {
      try {
        return globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || null;
      } catch {
        return null;
      }
    })();
    const beforeEvents = Array.isArray(context?.__recursionSmokePromptEvents)
      ? context.__recursionSmokePromptEvents.slice()
      : [];
    const installedKeys = [...new Set(beforeEvents
      .filter((entry) => entry && entry.cleared === false && String(entry.key || '').startsWith('recursion.'))
      .map((entry) => String(entry.key)))];
    let disableHookOk = false;
    let disableHookError = '';
    try {
      if (typeof globalThis.recursionOnDisable !== 'function') {
        throw new Error('recursionOnDisable unavailable');
      }
      await globalThis.recursionOnDisable();
      disableHookOk = true;
    } catch (error) {
      disableHookError = String(error?.message || error || 'Recursion disable hook failed.');
    }
    const afterEvents = Array.isArray(context?.__recursionSmokePromptEvents)
      ? context.__recursionSmokePromptEvents.slice()
      : [];
    const clearedPromptKeys = [...new Set(afterEvents
      .filter((entry) => entry && entry.cleared === true && String(entry.key || '').startsWith('recursion.'))
      .map((entry) => String(entry.key)))];
    const promptStateAvailable = Boolean(context?.prompts && typeof context.prompts === 'object');
    const remainingPromptKeys = promptStateAvailable
      ? Object.entries(context.prompts)
        .filter(([key, value]) => String(key || '').startsWith('recursion.') && String(value?.text ?? value ?? '').length > 0)
        .map(([key]) => String(key))
      : [];
    const recorderCleared = installedKeys.length > 0 && installedKeys.every((key) => clearedPromptKeys.includes(key));
    const hostPromptCleared = !promptStateAvailable || remainingPromptKeys.length === 0;
    const promptCleared = disableHookOk && recorderCleared && hostPromptCleared;
    const cleanup = {
      clearRequested: true,
      disableHookOk,
      disableHookError,
      installedPromptKeys: installedKeys,
      clearedPromptKeys,
      promptStateAvailable,
      remainingPromptKeys,
      recorderCleared,
      hostPromptCleared,
      promptCleared,
      promptEventCount: afterEvents.length
    };
    globalThis.__recursionSmokeGenerationCleanup = cleanup;
    globalThis.__recursionSmokeGeneration = {
      ...(globalThis.__recursionSmokeGeneration || {}),
      promptCleared,
      cleanup
    };
    return cleanup;
  };
}

async function selectRecursionMode(page, mode, timeoutMs) {
  const modeButton = page.locator('[data-recursion-mode-button]').first();
  const hasModeButton = await modeButton.count()
    .then(async (count) => count > 0 && await modeButton.isVisible().catch(() => false))
    .catch(() => false);
  if (hasModeButton) {
    await modeButton.click({ timeout: timeoutMs });
    await page.locator(`[data-recursion-mode-choice="${mode}"], [data-recursion-mode-choice-${mode}]`).first().click({ timeout: timeoutMs });
    return;
  }
  await page.locator('[data-recursion-setting-mode]').selectOption(mode, { timeout: timeoutMs });
  await page.locator('[data-recursion-setting-mode]').dispatchEvent('change');
}

async function applyRecursionModeSmokeStep(page, mode, timeoutMs) {
  if (mode === 'disabled') {
    await page.evaluate(() => {
      const button = document.querySelector('[data-recursion-power-toggle]');
      if (button?.getAttribute('aria-pressed') !== 'false') button.click();
    });
  } else {
    await page.evaluate(() => {
      const button = document.querySelector('[data-recursion-power-toggle]');
      if (button?.getAttribute('aria-pressed') === 'false') button.click();
    });
    await selectRecursionMode(page, mode, timeoutMs);
  }
  await page.waitForFunction(modeSmokeWaitScript(), mode, { timeout: timeoutMs });
  return await page.evaluate(modeSmokeReadStepScript(), mode);
}

async function runRecursionModeSmoke(page, timeoutMs) {
  const seed = await page.evaluate(modeSmokeSeedPromptScript());
  const steps = [];
  for (const mode of ['disabled', 'auto', 'manual', 'disabled']) {
    steps.push(await applyRecursionModeSmokeStep(page, mode, timeoutMs));
  }
  const sequence = steps.map((step) => step.mode);
  const ok = seed.seeded === true
    && sequence.join('|') === 'disabled|auto|manual|disabled'
    && steps.every((step) => step.modeApplied === true)
    && steps[0]?.promptCleared === true
    && steps.at(-1)?.promptCleared === true;
  const modeSmoke = {
    requested: true,
    ok,
    seed: {
      seeded: seed.seeded === true,
      promptKeys: Array.isArray(seed.promptKeys) ? seed.promptKeys.slice(0, 24) : [],
      error: sanitizeHarnessText(seed.error || '', 240)
    },
    sequence,
    steps: steps.map((step) => ({
      mode: String(step.mode || ''),
      selectedValue: String(step.selectedValue || ''),
      observedMode: String(step.observedMode || ''),
      modeApplied: step.modeApplied === true,
      statusText: sanitizeHarnessText(step.statusText || '', 160),
      modeText: sanitizeHarnessText(step.modeText || '', 160),
      promptCleared: step.promptCleared === true,
      promptKeys: Array.isArray(step.promptKeys) ? step.promptKeys.slice(0, 24) : []
    }))
  };
  await page.evaluate((value) => {
    globalThis.__recursionSmokeModeSmoke = value;
  }, modeSmoke).catch(() => {});
  return modeSmoke;
}

async function runBrowserUiSmoke({
  baseUrl,
  cookies = [],
  artifactLocation = null,
  timeoutMs = 30000,
  env = {},
  generationRequested = false,
  reasonerRequested = false
} = {}) {
  const consoleMessages = [];
  const pageErrors = [];
  let browser = null;
  let context = null;
  let page = null;
  let traceStarted = false;
  const artifacts = {};
  const binaryArtifactsAllowed = generationRequested !== true;

  async function captureFailureArtifacts() {
    if (!binaryArtifactsAllowed || !artifactLocation || !page) return;
    if (!artifacts.failureScreenshot) {
      try {
        const failure = artifactTarget(artifactLocation, 'screenshots/failure.png');
        await page.screenshot({ path: failure.target, fullPage: true });
        artifacts.failureScreenshot = failure.relativePath;
      } catch {
        // Screenshot capture is best-effort after a browser failure.
      }
    }
  }

  async function stopTraceArtifact() {
    if (!traceStarted || !context || !artifactLocation) return;
    try {
      const trace = artifactTarget(artifactLocation, 'playwright/trace.zip');
      await context.tracing.stop({ path: trace.target });
      artifacts.trace = trace.relativePath;
    } catch {
      await context.tracing.stop().catch(() => {});
    } finally {
      traceStarted = false;
    }
  }

  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({
      headless: env.RECURSION_PLAYWRIGHT_HEADFUL === '1' ? false : true
    });
    context = await browser.newContext({
      viewport: { width: 1366, height: 900 }
    });
    if (cookies.length) await context.addCookies(cookies);
    if (artifactLocation && binaryArtifactsAllowed) {
      await context.tracing.start({ screenshots: true, snapshots: true });
      traceStarted = true;
    }
    page = await context.newPage();
    page.on('console', (message) => {
      consoleMessages.push({
        type: message.type(),
        text: sanitizeHarnessText(message.text(), 240)
      });
    });
    page.on('pageerror', (error) => {
      pageErrors.push(compactBrowserIssue(error));
    });

    await page.goto(normalizeBaseUrl(baseUrl), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForSelector('[data-recursion-bar]', { timeout: timeoutMs });
    await page.waitForFunction(() => {
      return typeof globalThis.recursionGenerationInterceptor === 'function'
        && typeof globalThis.recursionOnEnable === 'function'
        && typeof globalThis.recursionOnDisable === 'function';
    }, null, { timeout: timeoutMs });

    const actionsButton = page.locator('[data-recursion-actions]').first();
    await actionsButton.click({ timeout: timeoutMs });
    await page.waitForFunction(() => {
      return document.querySelector('[data-recursion-settings-panel]')?.hidden === false
        && Boolean(document.querySelector('[data-recursion-provider-test]'));
    }, null, { timeout: timeoutMs });

    const progressButton = page.locator('[data-recursion-status-trigger]').first();
    if (!await page.evaluate(() => document.querySelector('[data-recursion-status-popover]')?.hidden === false).catch(() => false)) {
      await progressButton.click({ timeout: timeoutMs });
    }
    await page.waitForFunction(() => document.querySelector('[data-recursion-status-popover]')?.hidden === false, null, { timeout: timeoutMs });

    if (!generationRequested) {
      const modeSmoke = await runRecursionModeSmoke(page, timeoutMs).catch(async (error) => {
        const failedModeSmoke = {
          requested: true,
          ok: false,
          error: compactBrowserIssue(error)
        };
        await page.evaluate((value) => {
          globalThis.__recursionSmokeModeSmoke = value;
        }, failedModeSmoke).catch(() => {});
        const failed = new Error('Recursion mode smoke failed.');
        failed.status = 'fail';
        failed.result = 'browser-mode-smoke-failed';
        failed.cause = error;
        failed.snapshot = await page.evaluate(browserSnapshotScript()).catch(() => ({ modeSmoke: failedModeSmoke }));
        throw failed;
      });
      if (!modeSmoke?.ok) {
        const failed = new Error('Recursion mode smoke did not prove disabled/Auto/Manual/disabled cleanup.');
        failed.status = 'fail';
        failed.result = 'browser-mode-smoke-failed';
        failed.snapshot = await page.evaluate(browserSnapshotScript()).catch(() => ({ modeSmoke }));
        throw failed;
      }
    }

    if (generationRequested) {
      await page.evaluate(generationRecorderInstallScript());
      await selectRecursionMode(page, 'manual', timeoutMs);
      try {
        await page.waitForFunction(() => {
          const modeText = String(document.querySelector('[data-recursion-mode]')?.textContent || '');
          const selectValue = String(document.querySelector('[data-recursion-setting-mode]')?.value || '');
          return (!selectValue || selectValue === 'manual') && /Manual/i.test(modeText);
        }, null, { timeout: timeoutMs });
      } catch (error) {
        const manualProof = await page.evaluate(() => {
          const context = (() => {
            try {
              return globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || null;
            } catch {
              return null;
            }
          })();
          const modeText = String(document.querySelector('[data-recursion-mode]')?.textContent || '').toLowerCase();
          const observedMode = /manual/.test(modeText)
            ? 'manual'
            : (/auto/.test(modeText) ? 'auto' : 'unknown');
          const promptKeys = Object.entries(context?.prompts || {})
            .filter(([key, value]) => String(key || '').startsWith('recursion.') && String(value?.text ?? value ?? '').length > 0)
            .map(([key]) => String(key));
          const proof = {
            requested: true,
            mode: 'manual',
            observedMode,
            modeApplied: false,
            ok: false,
            disableHookOk: false,
            baselineClearOk: false,
            interceptorOk: false,
            promptInstalled: promptKeys.length > 0,
            promptKeys,
            promptEventCount: 0,
            error: 'manual mode was not applied'
          };
          globalThis.__recursionSmokeManualProof = proof;
          globalThis.__recursionSmokeGeneration = {
            ...(globalThis.__recursionSmokeGeneration || {}),
            requested: true,
            manualProof: proof
          };
          return proof;
        }).catch(() => ({
          requested: true,
          mode: 'manual',
          observedMode: 'unknown',
          modeApplied: false,
          ok: false,
          disableHookOk: false,
          baselineClearOk: false,
          interceptorOk: false,
          promptInstalled: false,
          promptKeys: [],
          promptEventCount: 0,
          error: 'manual mode was not applied'
        }));
        const failed = new Error('Recursion Manual mode did not apply before Auto smoke.');
        failed.status = 'fail';
        failed.result = 'generation-manual-mode-unavailable';
        failed.cause = error;
        failed.generation = { requested: true, manualProof };
        failed.snapshot = await page.evaluate(browserSnapshotScript()).catch(() => ({ generation: failed.generation }));
        throw failed;
      }
      const manualScopeProof = await page.evaluate(manualScopeProofScript(), 'Scene Frame').catch((error) => ({
        requested: true,
        available: false,
        disabledFamily: 'Scene Frame',
        disabled: false,
        label: '',
        error: compactBrowserIssue(error)
      }));
      await page.evaluate((proof) => {
        globalThis.__recursionSmokeManualScopeProof = proof;
        globalThis.__recursionSmokeGeneration = {
          ...(globalThis.__recursionSmokeGeneration || {}),
          requested: true,
          manualScopeProof: proof
        };
      }, manualScopeProof).catch(() => {});
      const manualProof = await page.evaluate(generationManualProofScript());
      if (!manualProof?.ok) {
        const failed = new Error('Recursion Manual mode did not install prompt text before Auto smoke.');
        failed.status = 'fail';
        failed.result = 'generation-manual-install-failed';
        failed.generation = { requested: true, manualProof };
        failed.snapshot = await page.evaluate(browserSnapshotScript()).catch(() => ({ generation: failed.generation }));
        throw failed;
      }
      await selectRecursionMode(page, 'auto', timeoutMs);
      if (reasonerRequested) {
        await page.locator('[data-recursion-setting-reasoner]').selectOption('always', { timeout: timeoutMs }).catch(() => {});
        await page.locator('[data-recursion-provider-enabled-reasoner]').check({ timeout: timeoutMs }).catch(() => {});
        await page.locator('[data-recursion-reasoner-provider-save]').click({ timeout: timeoutMs }).catch(() => {});
      }
      await page.waitForFunction(() => /Auto/i.test(document.querySelector('[data-recursion-mode]')?.textContent || ''), null, { timeout: timeoutMs });
    }

    const handButton = page.locator('[data-recursion-hand-toggle]').first();
    await handButton.click({ timeout: timeoutMs });
    await page.waitForFunction(() => document.querySelector('[data-recursion-hand-dropdown]')?.hidden === false, null, { timeout: timeoutMs });
    if (!await page.evaluate(() => document.querySelector('[data-recursion-status-popover]')?.hidden === false).catch(() => false)) {
      await progressButton.click({ timeout: timeoutMs });
    }
    await page.waitForFunction(() => document.querySelector('[data-recursion-status-popover]')?.hidden === false, null, { timeout: timeoutMs });

    const viewerButton = page.locator('[data-recursion-viewer-toggle]:visible').first();
    const viewerButtonAvailable = await viewerButton.count()
      .then(async (count) => count > 0 && await viewerButton.isVisible().catch(() => false))
      .catch(() => false);
    if (viewerButtonAvailable) {
      await viewerButton.click({ timeout: timeoutMs });
      await page.waitForFunction(() => {
        const viewer = document.querySelector('[data-recursion-viewer]');
        return Boolean(viewer && (viewer.open || viewer.hidden === false));
      }, null, { timeout: timeoutMs });
      await page.evaluate(() => {
        globalThis.__recursionSmokeViewerOpened = true;
      }).catch(() => {});
    }
    const viewerClosed = () => {
      const viewer = document.querySelector('[data-recursion-viewer]');
      return !viewer || (!viewer.open && (viewer.tagName === 'DIALOG' || viewer.hidden !== false));
    };
    if (viewerButtonAvailable) {
      await page.locator('[data-recursion-viewer-close]').first().click({ timeout: Math.min(timeoutMs, 5000) }).catch(() => {});
      const closed = await page.waitForFunction(viewerClosed, null, { timeout: Math.min(timeoutMs, 5000) })
        .then(() => true)
        .catch(() => false);
      if (!closed) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForFunction(viewerClosed, null, { timeout: Math.min(timeoutMs, 5000) }).catch(() => {});
      }
    }

    let generation = null;
    let cleanup = null;
    if (generationRequested) {
      const surface = await resolveVisibleSendSurface(page);
      const triggerSource = surface.evidence.inputFound || surface.evidence.buttonFound ? 'ui-send' : 'direct-bridge';
      const chatMutationSource = triggerSource === 'ui-send' ? 'visible-control' : 'context-chat';
      const visibleSendUsable = surface.evidence.inputUsable === true && surface.evidence.buttonUsable === true;
      const visibleSendUnavailable = triggerSource === 'ui-send' && !visibleSendUsable;
      const setup = await page.evaluate(generationBaseSetupScript(), {
        reasonerRequested,
        triggerSource,
        chatMutationSource,
        visibleSend: surface.evidence
      });
      generation = setup?.base || null;
      if (visibleSendUnavailable) {
        generation = await page.evaluate(generationEvidenceScript()).catch(() => generation);
        const failed = new Error('Recursion visible send surface is incomplete.');
        failed.status = 'fail';
        failed.result = 'generation-visible-send-unavailable';
        failed.generation = generation;
        failed.snapshot = await page.evaluate(browserSnapshotScript()).catch(() => ({ generation }));
        throw failed;
      }
      if (triggerSource === 'ui-send') {
        try {
          const inputMethod = await fillVisibleSendInput(page, surface.input.locator, setup.smokeMessageText || '', timeoutMs);
          await surface.button.locator.click({ timeout: timeoutMs });
          generation = await page.evaluate((inputMethod) => {
            const base = globalThis.__recursionSmokeGenerationBase || {};
            base.visibleSend = {
              ...(base.visibleSend || {}),
              inputMethod: String(inputMethod || '')
            };
            globalThis.__recursionSmokeGenerationBase = base;
            globalThis.__recursionSmokeGeneration = { ...(globalThis.__recursionSmokeGeneration || {}), visibleSend: base.visibleSend };
            return base;
          }, inputMethod).catch(() => generation);
        } catch (error) {
          generation = await page.evaluate(generationEvidenceScript()).catch(() => generation);
          const failed = new Error('Recursion visible send action failed.');
          failed.status = 'fail';
          failed.result = 'generation-visible-send-failed';
          failed.cause = error;
          failed.generation = generation;
          failed.snapshot = await page.evaluate(browserSnapshotScript()).catch(() => ({ generation }));
          throw failed;
        }
      } else {
        generation = await page.evaluate(generationDirectBridgeScript());
      }
      try {
        await page.waitForFunction(() => {
          const generation = (() => {
            const base = globalThis.__recursionSmokeGenerationBase || {};
            const context = (() => {
              try {
                return globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || null;
              } catch {
                return null;
              }
            })();
            const promptEvents = Array.isArray(context?.__recursionSmokePromptEvents)
              ? context.__recursionSmokePromptEvents.slice()
              : [];
            const handText = String(document.querySelector('[data-recursion-hand-count]')?.textContent || '');
            const packetText = String(document.querySelector('[data-recursion-prompt-packet]')?.textContent || '').trim();
            let packet = null;
            try {
              packet = packetText ? JSON.parse(packetText) : null;
            } catch {
              packet = null;
            }
            const promptInstalled = promptEvents.some((entry) => entry && entry.cleared === false && String(entry.key || '').startsWith('recursion.'));
            const packetId = String(packet?.packetId || '').trim();
            const handId = String(packet?.handId || '').trim();
            const selectedCardRefs = Array.isArray(packet?.selectedCardRefs) ? packet.selectedCardRefs : [];
            const chat = Array.isArray(context?.chat) ? context.chat : [];
            const chatLengthBefore = typeof base.hostGenerationEvidence?.chatLengthBefore === 'number'
              ? base.hostGenerationEvidence.chatLengthBefore
              : (typeof base.visibleSend?.chatLength === 'number' ? base.visibleSend.chatLength : null);
            const chatLengthAfter = Array.isArray(context?.chat) ? context.chat.length : null;
            const newMessages = typeof chatLengthBefore === 'number' ? chat.slice(Math.max(0, chatLengthBefore)) : [];
            const assistantMessageObserved = newMessages.some((message) => message && message.is_user === false);
            const markerOk = globalThis.__recursionSmokeHostGeneration?.ok === true;
            const promptPacketVisible = Boolean(packetId && handId && selectedCardRefs.length > 0);
            const visibleSend = {
              ...(base.visibleSend || {}),
              ok: base.triggerSource === 'ui-send'
                ? Boolean(base.visibleSend?.ok === true || (promptInstalled && typeof chatLengthAfter === 'number' && typeof chatLengthBefore === 'number' && chatLengthAfter > chatLengthBefore))
                : false,
              chatLength: typeof chatLengthAfter === 'number' ? chatLengthAfter : base.visibleSend?.chatLength ?? null
            };
            const hostGenerationRequired = base.triggerSource === 'ui-send';
            const hostGenerationContinued = hostGenerationRequired
              ? Boolean(markerOk || assistantMessageObserved || (typeof chatLengthAfter === 'number' && typeof chatLengthBefore === 'number' && chatLengthAfter > chatLengthBefore + 1))
              : null;
            const current = {
              interceptorOk: base.interceptorOk === true || promptInstalled || promptPacketVisible,
              visibleSend,
              hostGenerationRequired,
              hostGenerationContinued,
              hostGenerationEvidence: {
                chatLengthBefore,
                chatLengthAfter,
                assistantMessageObserved,
                markerOk
              },
              promptInstalled,
              handReady: /\bHand\s+[1-9]\d*/i.test(handText),
              promptPacketVisible
            };
            globalThis.__recursionSmokeGeneration = { ...(globalThis.__recursionSmokeGeneration || {}), ...current };
            return current;
          })();
          return generation.interceptorOk === true
            && generation.promptInstalled === true
            && generation.handReady === true
            && generation.promptPacketVisible === true;
        }, null, { timeout: timeoutMs });
      } catch (error) {
        const failed = new Error('Recursion generation bridge assertion failed.');
        failed.status = 'fail';
        failed.result = 'generation-smoke-assertion-failed';
        failed.cause = error;
        failed.generation = await page.evaluate(generationEvidenceScript()).catch(() => generation);
        throw failed;
      }
      generation = await page.evaluate(generationEvidenceScript());
      if (generation?.triggerSource === 'ui-send') {
        try {
          await page.waitForFunction(generationHostContinuationReadyScript(), null, { timeout: timeoutMs });
        } catch (error) {
          generation = await page.evaluate(generationEvidenceScript()).catch(() => generation);
          const failed = new Error('Recursion host generation did not continue after visible send.');
          failed.status = 'fail';
          failed.result = 'generation-host-continuation-failed';
          failed.cause = error;
          failed.generation = generation;
          failed.snapshot = await page.evaluate(browserSnapshotScript()).catch(() => ({ generation }));
          throw failed;
        }
        generation = await page.evaluate(generationEvidenceScript());
      }
    }

    const snapshot = await page.evaluate(browserSnapshotScript());
    if (!snapshot.rootMounted || !snapshot.barVisible || !snapshot.bridge?.interceptor || !snapshot.bridge?.enableHook || !snapshot.bridge?.disableHook) {
      const error = new Error('Recursion UI bridge assertion failed.');
      error.status = 'fail';
      error.result = 'browser-smoke-assertion-failed';
      throw error;
    }
    if (generationRequested && (!snapshot.generation?.interceptorOk || !snapshot.generation?.promptInstalled || !snapshot.generation?.handReady || !snapshot.generation?.promptPacketVisible)) {
      const error = new Error('Recursion generation bridge assertion failed.');
      error.status = 'fail';
      error.result = 'generation-smoke-assertion-failed';
      error.generation = generation || snapshot.generation;
      throw error;
    }
    if (artifactLocation && binaryArtifactsAllowed) {
      const desktop = artifactTarget(artifactLocation, 'screenshots/desktop.png');
      await page.screenshot({ path: desktop.target, fullPage: true });
      artifacts.desktopScreenshot = desktop.relativePath;
      await page.setViewportSize({ width: 390, height: 845 });
      await page.waitForTimeout(100);
      const phone = artifactTarget(artifactLocation, 'screenshots/phone.png');
      await page.screenshot({ path: phone.target, fullPage: true });
      artifacts.phoneScreenshot = phone.relativePath;
      await stopTraceArtifact();
    }

    if (generationRequested) {
      cleanup = await page.evaluate(generationPromptClearScript());
      if (!cleanup?.promptCleared) {
        const error = new Error('Recursion generation bridge cleanup assertion failed.');
        error.status = 'fail';
        error.result = 'generation-smoke-clear-failed';
        error.cleanup = cleanup;
        error.snapshot = snapshot;
        error.generation = generation || snapshot.generation;
        throw error;
      }
    }

    await context.close();
    return {
      status: 'pass',
      result: generationRequested ? 'generation-smoke-pass' : 'browser-smoke-pass',
      snapshot,
      cleanup,
      consoleMessages: consoleMessages.slice(-20),
      pageErrors: pageErrors.slice(-20),
      artifacts
    };
  } catch (error) {
    await captureFailureArtifacts();
    await stopTraceArtifact();
    const errorGeneration = error?.generation || null;
    const errorSnapshot = error?.snapshot || (errorGeneration ? { generation: errorGeneration } : null);
    return {
      status: error?.status || (error?.name === 'TimeoutError' ? 'fail' : 'environment-fail'),
      result: error?.result || (error?.name === 'TimeoutError' ? 'browser-smoke-timeout' : 'browser-smoke-failed'),
      error: compactBrowserIssue(error),
      snapshot: errorSnapshot,
      generation: errorGeneration,
      cleanup: error?.cleanup || null,
      consoleMessages: consoleMessages.slice(-20),
      pageErrors: pageErrors.slice(-20),
      artifacts
    };
  } finally {
    try {
      await stopTraceArtifact();
    } catch {
      // Trace cleanup is best effort after a failed browser smoke.
    }
    if (browser) await browser.close().catch(() => {});
  }
}

function promptMetadataFromBrowserResult(report, browserResult) {
  const generation = browserResult?.snapshot?.generation || browserResult?.generation || null;
  const packet = generation?.promptPacket || null;
  const cleanup = browserResult?.cleanup || null;
  const available = Boolean(packet?.packetId && packet?.handId);
  const installed = generation?.promptInstalled === true;
  const cleared = cleanup?.promptCleared === true || generation?.promptCleared === true;
  return {
    recordType: 'recursion.promptPacketMetadata',
    schemaVersion: 1,
    runId: report.runId,
    generatedAt: nowIso(),
    status: report.status,
    result: report.result,
    generationRequested: Boolean(generation?.requested),
    triggerSource: String(generation?.triggerSource || ''),
    chatMutationSource: String(generation?.chatMutationSource || ''),
    hostGenerationContinued: generation?.hostGenerationContinued === null ? null : generation?.hostGenerationContinued === true,
    manualProof: generation?.manualProof
      ? {
          requested: generation.manualProof.requested === true,
          mode: String(generation.manualProof.mode || ''),
          observedMode: String(generation.manualProof.observedMode || ''),
          modeApplied: generation.manualProof.modeApplied === true,
          ok: generation.manualProof.ok === true,
          disableHookOk: generation.manualProof.disableHookOk === true,
          baselineClearOk: generation.manualProof.baselineClearOk === true,
          interceptorOk: generation.manualProof.interceptorOk === true,
          promptInstalled: generation.manualProof.promptInstalled === true,
          promptKeys: Array.isArray(generation.manualProof.promptKeys)
            ? generation.manualProof.promptKeys.map((entry) => String(entry)).filter(Boolean).slice(0, 24)
            : [],
          promptEventCount: Number(generation.manualProof.promptEventCount) || 0,
          error: sanitizeHarnessText(generation.manualProof.error || '', 240)
        }
      : null,
    manualScopeProof: generation?.manualScopeProof
      ? {
          requested: generation.manualScopeProof.requested === true,
          available: generation.manualScopeProof.available === true,
          disabledFamily: sanitizeHarnessText(generation.manualScopeProof.disabledFamily || '', 80),
          disabled: generation.manualScopeProof.disabled === true,
          label: sanitizeHarnessText(generation.manualScopeProof.label || '', 80),
          hasFamilyMetadata: generation.manualScopeProof.hasFamilyMetadata === true,
          disabledFamilyInstalled: generation.manualScopeProof.disabledFamilyInstalled === true,
          promptRespectsDisabledFamily: generation.manualScopeProof.promptRespectsDisabledFamily === null ? null : generation.manualScopeProof.promptRespectsDisabledFamily === true,
          error: sanitizeHarnessText(generation.manualScopeProof.error || '', 240)
        }
      : null,
    available,
    packetHash: available ? sha256Text(JSON.stringify(packet)) : '',
    installStatus: installed ? 'installed' : 'not-installed',
    clearStatus: cleared ? 'cleared' : cleanup?.clearRequested ? 'not-cleared' : 'not-requested',
    packet: available
      ? {
          packetId: String(packet.packetId || ''),
          handId: String(packet.handId || ''),
          diagnostics: {
            composerLane: sanitizeHarnessText(packet.diagnostics?.composerLane || '', 80),
            reasonerStatus: sanitizeHarnessText(packet.diagnostics?.reasonerStatus || '', 80)
          },
          selectedCardRefs: Array.isArray(packet.selectedCardRefs)
            ? packet.selectedCardRefs.map((entry) => (
                entry && typeof entry === 'object'
                  ? {
                      id: sanitizeHarnessText(entry.id || '', 80),
                      family: sanitizeHarnessText(entry.family || '', 80),
                      role: sanitizeHarnessText(entry.role || '', 80)
                    }
                  : { id: sanitizeHarnessText(entry || '', 80), family: '', role: '' }
              )).slice(0, 24)
            : []
        }
      : null,
    promptKeys: Array.isArray(generation?.promptKeys)
      ? generation.promptKeys.map((entry) => String(entry)).filter(Boolean).slice(0, 24)
      : [],
    promptEventCount: Number(generation?.promptEventCount) || 0,
    promptEvents: Array.isArray(generation?.promptEvents)
      ? generation.promptEvents.map((entry) => ({
          key: String(entry?.key || ''),
          textHash: String(entry?.textHash || ''),
          textLength: Number(entry?.textLength) || 0,
          cleared: entry?.cleared === true,
          position: String(entry?.position || ''),
          depth: Number(entry?.depth) || 0,
          role: String(entry?.role || '')
        })).slice(-12)
      : [],
    cleanup: cleanup
      ? {
          clearRequested: cleanup.clearRequested === true,
          disableHookOk: cleanup.disableHookOk === true,
          promptCleared: cleanup.promptCleared === true,
          installedPromptKeys: Array.isArray(cleanup.installedPromptKeys) ? cleanup.installedPromptKeys.slice(0, 24) : [],
          clearedPromptKeys: Array.isArray(cleanup.clearedPromptKeys) ? cleanup.clearedPromptKeys.slice(0, 24) : []
        }
      : null
  };
}

function activityLatestRunFromReport(report, liveLog, browserResult) {
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const browserGeneration = browserResult?.snapshot?.generation || browserResult?.generation || null;
  return {
    recordType: 'recursion.activityLatestRun',
    schemaVersion: 1,
    runId: report.runId,
    generatedAt: nowIso(),
    status: report.status,
    result: report.result,
    strict: report.strict === true,
    checks: checks.map((check) => ({
      name: String(check?.name || ''),
      status: String(check?.status || ''),
      summary: String(check?.summary || '')
    })),
    warnings: Array.isArray(report.warnings) ? report.warnings : [],
    failures: Array.isArray(report.failures) ? report.failures : [],
    browser: browserResult
      ? {
          status: browserResult.status,
          result: browserResult.result,
          snapshot: {
            rootMounted: browserResult.snapshot?.rootMounted === true,
            barVisible: browserResult.snapshot?.barVisible === true,
            statusText: browserResult.snapshot?.statusText || '',
            modeText: browserResult.snapshot?.modeText || '',
            handText: browserResult.snapshot?.handText || '',
            ribbonText: browserResult.snapshot?.ribbonText || '',
            generation: browserGeneration
              ? {
                  requested: browserGeneration.requested === true,
                  reasonerRequested: browserGeneration.reasonerRequested === true,
                  triggerSource: browserGeneration.triggerSource || '',
                  chatMutationSource: browserGeneration.chatMutationSource || '',
                  hostGenerationContinued: browserGeneration.hostGenerationContinued === null ? null : browserGeneration.hostGenerationContinued === true,
                  manualProof: browserGeneration.manualProof
                    ? {
                        ok: browserGeneration.manualProof.ok === true,
                        mode: browserGeneration.manualProof.mode || '',
                        observedMode: browserGeneration.manualProof.observedMode || '',
                        modeApplied: browserGeneration.manualProof.modeApplied === true,
                        promptInstalled: browserGeneration.manualProof.promptInstalled === true,
                        promptEventCount: browserGeneration.manualProof.promptEventCount || 0
                      }
                    : null,
                  manualScopeProof: browserGeneration.manualScopeProof
                    ? {
                        available: browserGeneration.manualScopeProof.available === true,
                        disabledFamily: browserGeneration.manualScopeProof.disabledFamily || '',
                        disabled: browserGeneration.manualScopeProof.disabled === true,
                        hasFamilyMetadata: browserGeneration.manualScopeProof.hasFamilyMetadata === true,
                        disabledFamilyInstalled: browserGeneration.manualScopeProof.disabledFamilyInstalled === true,
                        promptRespectsDisabledFamily: browserGeneration.manualScopeProof.promptRespectsDisabledFamily === null ? null : browserGeneration.manualScopeProof.promptRespectsDisabledFamily === true
                      }
                    : null,
                  interceptorOk: browserGeneration.interceptorOk === true,
                  promptInstalled: browserGeneration.promptInstalled === true,
                  promptCleared: browserResult.cleanup?.promptCleared === true || browserGeneration.promptCleared === true,
                  handReady: browserGeneration.handReady === true,
                  promptPacketVisible: browserGeneration.promptPacketVisible === true,
                  promptKeys: browserGeneration.promptKeys || [],
                  promptEventCount: browserGeneration.promptEventCount || 0
                }
              : null
          }
        }
      : null,
    events: Array.isArray(liveLog) ? liveLog.map((entry) => redactHarnessValue(entry)) : []
  };
}

export function createBaseReport({ scriptName, args = {}, env = {}, runId = createRunId(scriptName) } = {}) {
  return {
    recordType: 'recursion.liveHarnessReport',
    schemaVersion: 1,
    runId,
    scriptName: String(scriptName || 'recursion-live-harness'),
    status: 'skipped',
    result: 'dry-run',
    startedAt: nowIso(),
    generatedAt: null,
    finishedAt: null,
    durationMs: null,
    mode: args.live ? 'live' : 'dry-run',
    dryRun: !args.live,
    strict: Boolean(args.strict || env.RECURSION_LIVE_STRICT === '1'),
    checks: [],
    environment: {
      baseUrlConfigured: Boolean(env.SILLYTAVERN_BASE_URL),
      userConfigured: Boolean(env.RECURSION_SILLYTAVERN_USER || env.RECURSION_SOAK_ST_USERS),
      passwordConfigured: Boolean(env.RECURSION_SILLYTAVERN_PASSWORD),
      liveGeneration: env.RECURSION_LIVE_GENERATION === '1',
      liveReasoner: env.RECURSION_LIVE_REASONER === '1',
      artifactDirConfigured: Boolean(env.RECURSION_ARTIFACT_DIR)
    },
    warnings: [],
    failures: [],
    nextAction: null
  };
}

export function addCheck(report, check) {
  report.checks.push({
    name: sanitizeHarnessText(check?.name || 'unnamed-check', 120),
    status: sanitizeHarnessText(check?.status || 'skipped', 80),
    summary: sanitizeHarnessText(check?.summary || '', 300),
    details: redactHarnessValue(check?.details || {})
  });
  return report;
}

export function setReportStatus(report, status, result = status) {
  report.status = status;
  report.result = result;
  report.failures = report.checks.filter((check) => !['pass', 'skipped'].includes(check.status));
  return report;
}

function strictWarningFailures(report) {
  if (!report?.strict || !Array.isArray(report.warnings) || report.warnings.length === 0) return [];
  return report.warnings.map((warning) => {
    if (typeof warning === 'string') {
      return {
        name: 'strict-warning',
        status: 'fail',
        summary: warning
      };
    }
    return {
      name: warning.name || 'strict-warning',
      status: 'fail',
      summary: warning.summary || 'Strict mode promoted warning to failure.'
    };
  });
}

function applyStrictWarnings(report) {
  const strictFailures = strictWarningFailures(report);
  if (strictFailures.length === 0) return report;
  const existingFailures = Array.isArray(report.failures) ? report.failures : [];
  report.failures = [
    ...existingFailures.filter((failure) => !strictFailures.some((strictFailure) => strictFailure.name === failure.name && strictFailure.summary === failure.summary)),
    ...strictFailures
  ];
  if (['pass', 'skipped'].includes(report.status)) {
    report.status = 'fail';
    report.result = 'strict-warning';
  }
  return report;
}

export function finalizeReport(report) {
  applyStrictWarnings(report);
  const output = redactHarnessValue({
    ...report,
    generatedAt: nowIso(),
    finishedAt: nowIso(),
    durationMs: elapsedMs(report.startedAt)
  });
  return output;
}

export function reportToSummary(report) {
  const failures = Array.isArray(report.failures) ? report.failures : [];
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  const lines = [
    `# ${sanitizeHarnessText(report.scriptName, 120)}`,
    '',
    `Status: ${sanitizeHarnessText(report.status, 80)}`,
    `Result: ${sanitizeHarnessText(report.result, 120)}`,
    `Run: ${sanitizeHarnessText(report.runId, 120)}`,
    `Mode: ${sanitizeHarnessText(report.mode, 80)}`,
    ''
  ];
  if (failures.length) {
    lines.push('## Failures', '');
    for (const failure of failures) {
      lines.push(`- ${sanitizeHarnessText(failure.status, 80)}: ${sanitizeHarnessText(failure.name, 120)} - ${sanitizeHarnessText(failure.summary, 300)}`);
    }
    lines.push('');
  }
  if (warnings.length) {
    lines.push('## Warnings', '');
    for (const warning of warnings) {
      if (typeof warning === 'string') {
        lines.push(`- ${sanitizeHarnessText(warning, 300)}`);
      } else {
        lines.push(`- ${sanitizeHarnessText(warning.status || 'warning', 80)}: ${sanitizeHarnessText(warning.name || 'warning', 120)} - ${sanitizeHarnessText(warning.summary || '', 300)}`);
      }
    }
    lines.push('');
  }
  if (Array.isArray(report.checks) && report.checks.length) {
    lines.push('## Checks', '');
    for (const check of report.checks) {
      lines.push(`- ${sanitizeHarnessText(check.status, 80)}: ${sanitizeHarnessText(check.name, 120)} - ${sanitizeHarnessText(check.summary, 300)}`);
    }
    lines.push('');
  }
  if (report.nextAction) {
    lines.push('## Next Action', '', sanitizeHarnessText(report.nextAction, 500), '');
  }
  return `${lines.join('\n')}\n`;
}

export function writeReportArtifacts(report, { artifactRoot, family = 'live-smoke' } = {}) {
  const { dir } = artifactRunDirectory(report, { artifactRoot, family });
  const artifactRecord = {
    ...(report.artifacts || {}),
    summary: 'summary.md',
    report: 'report.json'
  };
  mkdirSync(dir, { recursive: true });
  report.artifacts = artifactRecord;
  writeFileSync(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(join(dir, 'summary.md'), reportToSummary(report), 'utf8');
  return artifactRecord;
}

export function artifactRunDirectory(report, { artifactRoot, family = 'live-smoke' } = {}) {
  const root = resolve(artifactRoot || process.env.RECURSION_ARTIFACT_DIR || 'artifacts');
  const relativeDirectory = join(family, safeId(report.runId, 'run'));
  return {
    root,
    relativeDirectory: relativeDirectory.replace(/\\/g, '/'),
    dir: join(root, relativeDirectory)
  };
}

export function prepareArtifactRunDirectory(report, options = {}) {
  try {
    const location = artifactRunDirectory(report, options);
    mkdirSync(location.dir, { recursive: true });
    return {
      ok: true,
      ...location
    };
  } catch (error) {
    addCheck(report, {
      name: 'artifact-write',
      status: 'environment-fail',
      summary: 'Artifact directory could not be prepared.',
      details: {
        name: error?.name,
        code: error?.code
      }
    });
    setReportStatus(report, 'environment-fail', 'artifact-write-failed');
    report.nextAction = 'Set RECURSION_ARTIFACT_DIR to a writable directory or omit --write-artifacts.';
    return {
      ok: false,
      report: finalizeReport(report)
    };
  }
}

function writeJsonArtifact(report, artifactLocation, relativePath, value) {
  try {
    const { relativePath: safeRelativePath, target } = artifactTarget(artifactLocation, relativePath);
    writeFileSync(target, `${JSON.stringify(redactHarnessValue(value), null, 2)}\n`, 'utf8');
    return safeRelativePath;
  } catch (error) {
    addCheck(report, {
      name: 'artifact-write',
      status: 'environment-fail',
      summary: 'Artifact write failed.',
      details: {
        name: error?.name,
        code: error?.code
      }
    });
    setReportStatus(report, 'environment-fail', 'artifact-write-failed');
    report.nextAction = 'Set RECURSION_ARTIFACT_DIR to a writable directory or omit --write-artifacts.';
    return null;
  }
}

function writeTextArtifact(report, artifactLocation, relativePath, value) {
  try {
    const { relativePath: safeRelativePath, target } = artifactTarget(artifactLocation, relativePath);
    writeFileSync(target, String(value ?? ''), 'utf8');
    return safeRelativePath;
  } catch (error) {
    addCheck(report, {
      name: 'artifact-write',
      status: 'environment-fail',
      summary: 'Artifact write failed.',
      details: {
        name: error?.name,
        code: error?.code
      }
    });
    setReportStatus(report, 'environment-fail', 'artifact-write-failed');
    report.nextAction = 'Set RECURSION_ARTIFACT_DIR to a writable directory or omit --write-artifacts.';
    return null;
  }
}

function artifactTextFiles(artifactLocation) {
  const files = [];
  const root = artifactLocation?.dir;
  if (!root) return files;
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(root, absolutePath).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        walk(absolutePath);
      } else if (entry.isFile() && ARTIFACT_TEXT_FILE_PATTERN.test(entry.name) && !REDACTION_SCAN_SKIP_PATHS.has(relativePath)) {
        files.push({ absolutePath, relativePath });
      }
    }
  }
  try {
    walk(root);
  } catch {
    return files;
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function safeRedactedArtifactValue(value) {
  if (value === null || value === undefined || value === '' || value === false) return true;
  if (typeof value === 'string') return value.trim().toLowerCase() === '[redacted]';
  if (Array.isArray(value)) return value.every((entry) => safeRedactedArtifactValue(entry));
  return false;
}

function isForbiddenArtifactKey(normalizedKey) {
  if (!normalizedKey || normalizedKey.endsWith('count')) return false;
  if (FORBIDDEN_ARTIFACT_KEYS.has(normalizedKey)) return true;
  if (FORBIDDEN_ARTIFACT_KEY_SUFFIXES.some((suffix) => normalizedKey.endsWith(suffix))) return true;
  return FORBIDDEN_ARTIFACT_KEY_CONTAINS.some((fragment) => normalizedKey.includes(fragment));
}

function artifactJsonFindings(value, relativePath) {
  const findings = [];
  const visiting = new WeakSet();
  const valueSecretPatterns = FORBIDDEN_ARTIFACT_TEXT_PATTERNS;

  function addFinding(reason, path) {
    findings.push({
      file: relativePath,
      reason,
      path: path.join('.')
    });
  }

  function visit(input, path = [], key = '') {
    const normalizedKey = normalizeHarnessKey(key);
    if (normalizedKey === 'redactedfields') return;
    if (isForbiddenArtifactKey(normalizedKey) && !safeRedactedArtifactValue(input)) {
      addFinding('sensitive-json-key', path);
    }
    if (typeof input === 'string') {
      if (valueSecretPatterns.some((pattern) => pattern.test(input))) {
        addFinding('sensitive-text', path);
      }
      return;
    }
    if (!input || typeof input !== 'object') return;
    if (visiting.has(input)) return;
    visiting.add(input);
    try {
      if (Array.isArray(input)) {
        input.forEach((entry, index) => visit(entry, [...path, String(index)]));
        return;
      }
      for (const [childKey, child] of Object.entries(input)) {
        visit(child, [...path, childKey], childKey);
      }
    } finally {
      visiting.delete(input);
    }
  }

  visit(value);
  return findings;
}

function artifactRedactionFindings(text, relativePath) {
  try {
    return artifactJsonFindings(JSON.parse(text), relativePath);
  } catch {
    // Non-JSON text artifacts use conservative string scanning.
  }
  const findings = [];
  for (const pattern of FORBIDDEN_ARTIFACT_TEXT_PATTERNS) {
    if (pattern.test(text)) {
      findings.push({
        file: relativePath,
        reason: 'sensitive-text'
      });
      break;
    }
  }
  return findings;
}

function scrubRedactionFindings(report, artifactLocation, findings = []) {
  const root = resolve(artifactLocation?.dir || '');
  const scrubbed = [];
  for (const file of [...new Set(findings.map((finding) => finding.file).filter(Boolean))]) {
    if (REDACTION_SCAN_SKIP_PATHS.has(file)) continue;
    const target = resolve(root, file);
    const inside = relative(root, target).replace(/\\/g, '/');
    if (!inside || inside === '..' || inside.startsWith('../') || isAbsolute(inside)) continue;
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify({
        recordType: 'recursion.artifactScrubbed',
        schemaVersion: 1,
        runId: report.runId,
        scrubbedAt: nowIso(),
        originalPath: file,
        status: 'scrubbed',
        reason: 'artifact-redaction-failed'
      }, null, 2)}\n`, 'utf8');
      scrubbed.push(file);
    } catch {
      // Scrub failures are still represented by the redaction failure status.
    }
  }
  return scrubbed;
}

function rewriteStatusJsonArtifact(report, artifactLocation, relativePath) {
  try {
    const target = resolve(artifactLocation.dir, normalizeRelativeFilePath(relativePath));
    const inside = relative(artifactLocation.dir, target).replace(/\\/g, '/');
    if (!inside || inside === '..' || inside.startsWith('../') || isAbsolute(inside)) return null;
    const parsed = JSON.parse(readFileSync(target, 'utf8'));
    parsed.status = report.status;
    parsed.result = report.result;
    parsed.generatedAt = nowIso();
    return writeJsonArtifact(report, artifactLocation, relativePath, parsed);
  } catch {
    return null;
  }
}

function rewriteStatusArtifacts(report, artifactLocation) {
  rewriteStatusJsonArtifact(report, artifactLocation, 'prompt/latest-packet-metadata.json');
  rewriteStatusJsonArtifact(report, artifactLocation, 'activity/latest-run.json');
}

function safeFailureCheckList(checks = []) {
  return checks.map((check) => ({
    name: sanitizeHarnessText(check?.name || '', 120),
    status: sanitizeHarnessText(check?.status || '', 80),
    summary: sanitizeHarnessText(check?.summary || '', 300)
  }));
}

function minimalRedactionFailureReport(report) {
  return {
    recordType: report.recordType || 'recursion.liveHarnessReport',
    schemaVersion: report.schemaVersion || 1,
    runId: report.runId,
    scriptName: sanitizeHarnessText(report.scriptName || 'recursion-live-harness', 120),
    status: 'fail',
    result: 'artifact-redaction-failed',
    startedAt: report.startedAt || null,
    generatedAt: nowIso(),
    finishedAt: nowIso(),
    durationMs: elapsedMs(report.startedAt),
    mode: report.mode || 'live',
    dryRun: report.dryRun === true,
    strict: report.strict === true,
    checks: safeFailureCheckList(report.checks),
    environment: redactHarnessValue(report.environment || {}),
    warnings: Array.isArray(report.warnings) ? report.warnings.map((warning) => redactHarnessValue(warning)) : [],
    failures: safeFailureCheckList(report.failures),
    nextAction: sanitizeHarnessText(report.nextAction || 'Inspect diagnostics/redaction-check.json and rerun after artifact redaction is fixed.', 500),
    artifacts: {
      ...(report.artifacts || {}),
      summary: 'summary.md',
      report: 'report.json',
      redactionCheck: 'diagnostics/redaction-check.json'
    }
  };
}

function writeMinimalRedactionFailureArtifacts(report, options = {}) {
  const safeReport = minimalRedactionFailureReport(report);
  const { dir } = artifactRunDirectory(safeReport, options);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.json'), `${JSON.stringify(safeReport, null, 2)}\n`, 'utf8');
  writeFileSync(join(dir, 'summary.md'), reportToSummary(safeReport), 'utf8');
  report.artifacts = safeReport.artifacts;
  return safeReport;
}

function scanGeneratedArtifacts(report, artifactLocation) {
  const files = artifactTextFiles(artifactLocation);
  const findings = [];
  for (const file of files) {
    let text = '';
    try {
      text = readFileSync(file.absolutePath, 'utf8');
    } catch {
      findings.push({
        file: file.relativePath,
        reason: 'artifact-read-failed'
      });
      continue;
    }
    findings.push(...artifactRedactionFindings(text, file.relativePath));
  }
  return {
    recordType: 'recursion.redactionCheck',
    schemaVersion: 1,
    runId: report.runId,
    generatedAt: nowIso(),
    status: findings.length ? 'fail' : 'pass',
    scannedFileCount: files.length,
    scannedFiles: files.map((file) => file.relativePath),
    findings
  };
}

export function attachReportArtifacts(report, options = {}) {
  try {
    if (options.family !== 'live-smoke/sillytavern' || report.dryRun === true) {
      writeReportArtifacts(report, options);
      return report;
    }
    report.artifacts = {
      ...(report.artifacts || {}),
      redactionCheck: 'diagnostics/redaction-check.json'
    };
    writeReportArtifacts(report, options);
    const artifactLocation = artifactRunDirectory(report, options);
    const redactionCheck = scanGeneratedArtifacts(report, artifactLocation);
    const redactionPath = writeJsonArtifact(report, artifactLocation, 'diagnostics/redaction-check.json', redactionCheck);
    if (redactionPath) {
      report.artifacts = {
        ...(report.artifacts || {}),
        redactionCheck: redactionPath
      };
    }
    if (redactionCheck.status !== 'pass') {
      const scrubbedFiles = scrubRedactionFindings(report, artifactLocation, redactionCheck.findings);
      addCheck(report, {
        name: 'artifact-redaction-check',
        status: 'fail',
        summary: 'Generated artifacts contain unredacted sensitive material.',
        details: {
          findingCount: redactionCheck.findings.length,
          scrubbedFiles,
          findings: redactionCheck.findings.map((finding) => ({
            file: finding.file,
            reason: finding.reason
          }))
        }
      });
      setReportStatus(report, 'fail', 'artifact-redaction-failed');
    }
    rewriteStatusArtifacts(report, artifactLocation);
    writeReportArtifacts(report, options);
    const finalRedactionCheck = scanGeneratedArtifacts(report, artifactLocation);
    if (finalRedactionCheck.status !== 'pass') {
      scrubRedactionFindings(report, artifactLocation, finalRedactionCheck.findings);
      const safeReport = writeMinimalRedactionFailureArtifacts(report, options);
      const finalCheckPath = writeJsonArtifact(safeReport, artifactLocation, 'diagnostics/redaction-check.json', {
        ...finalRedactionCheck,
        status: 'fail',
        generatedAt: nowIso()
      });
      if (finalCheckPath) {
        safeReport.artifacts = {
          ...(safeReport.artifacts || {}),
          redactionCheck: finalCheckPath
        };
      }
      return safeReport;
    }
    return report;
  } catch (error) {
    delete report.artifacts;
    addCheck(report, {
      name: 'artifact-write',
      status: 'environment-fail',
      summary: 'Artifact write failed.',
      details: {
        name: error?.name,
        code: error?.code
      }
    });
    setReportStatus(report, 'environment-fail', 'artifact-write-failed');
    report.nextAction = 'Set RECURSION_ARTIFACT_DIR to a writable directory or omit --write-artifacts.';
    return finalizeReport(report);
  }
}

export function exitCodeForReport(report) {
  return ['pass', 'skipped'].includes(report.status) ? 0 : 1;
}

function readinessFixtureHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Recursion Playwright Readiness</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 24px; }
      button { min-height: 44px; min-width: 160px; }
    </style>
  </head>
  <body>
    <button type="button" aria-label="readiness action">Ready</button>
    <output data-readiness-result aria-live="polite">idle</output>
    <script>
      document.querySelector('button').addEventListener('click', () => {
        document.querySelector('[data-readiness-result]').textContent = 'ready-clicked';
      });
    </script>
  </body>
</html>`;
}

function eventMessage(value) {
  if (typeof value?.text === 'function') return value.text();
  return String(value?.message || value || '');
}

export async function runPlaywrightReadiness({
  argv = [],
  env = process.env,
  artifactRoot
} = {}) {
  const args = parseHarnessArgs(argv);
  const readinessDryRun = args.dryRunRequested;
  const reportArgs = { ...args, live: !readinessDryRun };
  let report = createBaseReport({ scriptName: 'check-playwright-readiness', args: reportArgs, env });
  if (args.liveRequested && args.dryRunRequested) {
    report.warnings.push({
      name: 'dry-run-override',
      status: 'warn',
      summary: '--dry-run was provided with --live, so no live browser work will run.'
    });
  }
  report.mode = readinessDryRun ? 'dry-run' : 'readiness';
  report.dryRun = readinessDryRun;
  addCheck(report, {
    name: 'sillytavern-contact',
    status: 'pass',
    summary: 'Readiness does not contact SillyTavern or mutate host state.'
  });

  if (readinessDryRun) {
    addCheck(report, {
      name: 'dry-run',
      status: 'skipped',
      summary: 'Playwright launch skipped by explicit dry-run.'
    });
    setReportStatus(report, 'skipped', 'dry-run');
    report.nextAction = 'Run without --dry-run to attempt offline Playwright browser readiness.';
    report = finalizeReport(report);
    if (args.writeArtifacts) report = attachReportArtifacts(report, { artifactRoot, family: 'playwright-readiness' });
    return report;
  }

  let artifactLocation = null;
  if (args.writeArtifacts) {
    artifactLocation = prepareArtifactRunDirectory(report, { artifactRoot, family: 'playwright-readiness' });
    if (!artifactLocation.ok) return artifactLocation.report;
  }

  let playwright;
  try {
    playwright = await import('playwright');
  } catch (error) {
    addCheck(report, {
      name: 'playwright-import',
      status: 'environment-fail',
      summary: 'Playwright is not available to this checkout.',
      details: {
        name: error?.name,
        code: error?.code
      }
    });
    setReportStatus(report, 'environment-fail', 'playwright-unavailable');
    report.nextAction = 'Install Playwright for this checkout or run this command in an environment where Playwright is available.';
    report = finalizeReport(report);
    if (args.writeArtifacts) report = attachReportArtifacts(report, { artifactRoot, family: 'playwright-readiness' });
    return report;
  }

  const browserErrors = [];
  let browser = null;
  let context = null;
  try {
    browser = await playwright.chromium.launch({ headless: env.RECURSION_SILLYTAVERN_HEADLESS !== '0' });
    context = typeof browser.newContext === 'function'
      ? await browser.newContext({ viewport: { width: 1280, height: 720 } })
      : browser;
    if (args.writeArtifacts && typeof context.tracing?.start === 'function') {
      await context.tracing.start({ screenshots: true, snapshots: true });
    }
    const page = typeof context.newPage === 'function' ? await context.newPage() : await browser.newPage();
    if (typeof page.on === 'function') {
      page.on('console', (entry) => {
        const type = typeof entry?.type === 'function' ? entry.type() : entry?.type;
        if (type === 'error') browserErrors.push(eventMessage(entry));
      });
      page.on('pageerror', (entry) => browserErrors.push(eventMessage(entry)));
    }
    await page.setContent(readinessFixtureHtml());
    await page.getByRole('button', { name: 'readiness action' }).click();
    const resultText = await page.locator('[data-readiness-result]').textContent();
    if (resultText !== 'ready-clicked') {
      throw new Error(`Readiness fixture did not update after click: ${resultText}`);
    }

    if (args.writeArtifacts) {
      mkdirSync(join(artifactLocation.dir, 'screenshots'), { recursive: true });
      if (typeof page.setViewportSize === 'function') await page.setViewportSize({ width: 1280, height: 720 });
      await page.screenshot({ path: join(artifactLocation.dir, 'screenshots', 'desktop.png') });
      if (typeof page.setViewportSize === 'function') await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: join(artifactLocation.dir, 'screenshots', 'phone.png') });
      report.artifacts = {
        ...(report.artifacts || {}),
        desktopScreenshot: 'screenshots/desktop.png',
        phoneScreenshot: 'screenshots/phone.png'
      };
      if (typeof context.tracing?.stop === 'function') {
        mkdirSync(join(artifactLocation.dir, 'playwright'), { recursive: true });
        await context.tracing.stop({ path: join(artifactLocation.dir, 'playwright', 'trace.zip') });
        report.artifacts.trace = 'playwright/trace.zip';
      }
    }

    addCheck(report, {
      name: 'browser-control',
      status: 'pass',
      summary: 'Chromium launched, role locator clicked, and readiness fixture updated.'
    });
    if (browserErrors.length) {
      report.warnings.push({
        name: 'browser-console',
        status: 'warn',
        summary: `${browserErrors.length} browser error event(s) were observed.`
      });
    }
    setReportStatus(report, 'pass', 'readiness-pass');
    report.nextAction = browserErrors.length
      ? 'Inspect readiness warnings before using live smoke.'
      : 'Playwright readiness passed; dedicated-user live guardrails may be run next.';
  } catch (error) {
    addCheck(report, {
      name: 'browser-control',
      status: 'environment-fail',
      summary: 'Playwright browser control failed.',
      details: {
        name: error?.name,
        code: error?.code,
        message: error?.message
      }
    });
    setReportStatus(report, 'environment-fail', 'browser-control-failed');
    report.nextAction = 'Repair local Playwright browser support before using live smoke.';
  } finally {
    if (context && context !== browser && typeof context.close === 'function') {
      try {
        await context.close();
      } catch {}
    }
    if (browser && typeof browser.close === 'function') {
      try {
        await browser.close();
      } catch {}
    }
  }

  report = finalizeReport(report);
  if (args.writeArtifacts) report = attachReportArtifacts(report, { artifactRoot, family: 'playwright-readiness' });
  return report;
}

export async function runSoakUsersPreflight({ argv = [], env = process.env, artifactRoot, fetchImpl = globalThis.fetch } = {}) {
  const args = parseHarnessArgs(argv);
  let report = createBaseReport({ scriptName: 'check-sillytavern-soak-users', args, env });
  if (args.liveRequested && args.dryRunRequested) {
    report.warnings.push({
      name: 'dry-run-override',
      status: 'warn',
      summary: '--dry-run was provided with --live, so no live SillyTavern work will run.'
    });
  }
  const configuredValue = env.RECURSION_SOAK_ST_USERS || env.RECURSION_SILLYTAVERN_USER;
  const hasConfiguredUsers = String(configuredValue ?? '').trim() !== '';
  const configured = validateSoakUserList(configuredValue);
  report.users = configured.users;
  addCheck(report, {
    name: 'dedicated-user-policy',
    status: !args.live && !hasConfiguredUsers ? 'skipped' : configured.status,
    summary: !args.live && !hasConfiguredUsers
      ? 'No users configured; dry-run stopped before any live-user validation could mutate state.'
      : configured.ok
      ? 'All configured users match recursion-soak-* policy.'
      : 'One or more configured users are unsafe for automated live tests.',
    details: { results: configured.results }
  });

  if (!args.live && !hasConfiguredUsers) {
    addCheck(report, {
      name: 'live-mutation',
      status: 'skipped',
      summary: 'No SillyTavern state was touched because --live was not set.'
    });
    setReportStatus(report, 'skipped', 'dry-run');
    report.nextAction = 'Set RECURSION_SOAK_ST_USERS to dedicated recursion-soak-* users before running with --live.';
  } else if (!configured.ok) {
    setReportStatus(report, 'unsafe-user', 'unsafe-user');
    report.nextAction = 'Set RECURSION_SOAK_ST_USERS to dedicated recursion-soak-* users.';
  } else if (!args.live) {
    addCheck(report, {
      name: 'live-mutation',
      status: 'skipped',
      summary: 'No SillyTavern state was touched because --live was not set.'
    });
    setReportStatus(report, 'skipped', 'dry-run');
    report.nextAction = 'Re-run with --live only after dedicated recursion-soak-* users exist.';
  } else if (!env.SILLYTAVERN_BASE_URL) {
    addCheck(report, {
      name: 'base-url',
      status: 'environment-fail',
      summary: 'SILLYTAVERN_BASE_URL is required for live checks.'
    });
    setReportStatus(report, 'environment-fail', 'missing-base-url');
    report.nextAction = 'Set SILLYTAVERN_BASE_URL before attempting guarded live checks.';
  } else {
    const artifactLocation = args.writeArtifacts
      ? prepareArtifactRunDirectory(report, { artifactRoot, family: 'live-smoke/sillytavern' })
      : null;
    if (artifactLocation && !artifactLocation.ok) return artifactLocation.report;

    const probeResult = await runStorageProbeSuite({
      baseUrl: env.SILLYTAVERN_BASE_URL,
      users: configured.users,
      env,
      fetchImpl,
      runId: report.runId
    });
    report.storageProbe = probeResult;
    for (const warning of probeResult.warnings || []) report.warnings.push(warning);
    addCheck(report, {
      name: 'storage-isolation-probe',
      status: probeResult.status,
      summary: probeResult.status === 'pass'
        ? 'Dedicated-user storage probe completed.'
        : 'Dedicated-user storage probe failed before live smoke.',
      details: {
        result: probeResult.result,
        users: probeResult.users,
        probeCount: probeResult.probes?.length || 0,
        isolationChecks: probeResult.isolationChecks?.length || 0,
        cleanup: probeResult.cleanup || [],
        error: probeResult.error
      }
    });
    setReportStatus(report, probeResult.status, probeResult.result);
    report.nextAction = probeResult.status === 'pass'
      ? 'Storage probe passed; run smoke-sillytavern-live.mjs for no-generation browser UI evidence.'
      : 'Create dedicated recursion-soak-* users, verify credentials, and rerun the storage preflight.';
    if (artifactLocation?.ok) {
      const probePath = writeJsonArtifact(report, artifactLocation, 'storage/probe.json', probeResult);
      if (probePath) report.artifacts = { ...(report.artifacts || {}), storageProbe: probePath };
    }
  }

  report = finalizeReport(report);
  if (args.writeArtifacts) report = attachReportArtifacts(report, { artifactRoot, family: 'live-smoke/sillytavern' });
  return report;
}

export async function runSillyTavernLiveSmoke({ argv = [], env = process.env, artifactRoot, fetchImpl = globalThis.fetch, localRoot = process.cwd() } = {}) {
  const args = parseHarnessArgs(argv);
  let report = createBaseReport({ scriptName: 'smoke-sillytavern-live', args, env });
  if (args.liveRequested && args.dryRunRequested) {
    report.warnings.push({
      name: 'dry-run-override',
      status: 'warn',
      summary: '--dry-run was provided with --live, so no live browser, chat, storage, prompt, or provider work will run.'
    });
  }
  const hasConfiguredUser = String(env.RECURSION_SILLYTAVERN_USER ?? '').trim() !== '';
  const userResult = validateSoakUserHandle(env.RECURSION_SILLYTAVERN_USER);
  report.user = userResult.user || null;
  addCheck(report, {
    name: 'dedicated-user-policy',
    status: !args.live && !hasConfiguredUser ? 'skipped' : userResult.status,
    summary: !args.live && !hasConfiguredUser
      ? 'No user configured; dry-run stopped before any live-user validation could mutate state.'
      : userResult.ok
      ? 'Configured user matches recursion-soak-* policy.'
      : 'Configured user is unsafe for automated live smoke.',
    details: userResult
  });

  if (!args.live && !hasConfiguredUser) {
    addCheck(report, {
      name: 'live-mutation',
      status: 'skipped',
      summary: 'No browser, chat, storage, prompt, or provider state was touched because --live was not set.'
    });
    setReportStatus(report, 'skipped', 'dry-run');
    report.nextAction = 'Set RECURSION_SILLYTAVERN_USER to a dedicated recursion-soak-* user before running with --live.';
  } else if (!userResult.ok) {
    setReportStatus(report, 'unsafe-user', 'unsafe-user');
    report.nextAction = 'Set RECURSION_SILLYTAVERN_USER to a dedicated recursion-soak-* user.';
  } else if (!args.live) {
    addCheck(report, {
      name: 'live-mutation',
      status: 'skipped',
      summary: 'No browser, chat, storage, prompt, or provider state was touched because --live was not set.'
    });
    setReportStatus(report, 'skipped', 'dry-run');
    report.nextAction = 'Re-run with --live to authenticate, compare served files, and check the Recursion UI with Playwright.';
  } else if (!env.SILLYTAVERN_BASE_URL) {
    addCheck(report, {
      name: 'base-url',
      status: 'environment-fail',
      summary: 'SILLYTAVERN_BASE_URL is required for live smoke.'
    });
    setReportStatus(report, 'environment-fail', 'missing-base-url');
    report.nextAction = 'Set SILLYTAVERN_BASE_URL before attempting guarded live smoke.';
  } else {
    const artifactLocation = args.writeArtifacts
      ? prepareArtifactRunDirectory(report, { artifactRoot, family: 'live-smoke/sillytavern' })
      : null;
    if (artifactLocation && !artifactLocation.ok) return artifactLocation.report;

    const liveLog = [];
    let lastBrowserResult = null;
    const event = (phase, status, label, details = {}) => {
      liveLog.push({
        recordType: 'recursion.liveSmokeEvent',
        schemaVersion: 1,
        runId: report.runId,
        recordedAt: nowIso(),
        phase,
        status,
        label: sanitizeHarnessText(label, 240),
        details: redactHarnessValue(details)
      });
    };

    const configuredTimeoutMs = Number(env.RECURSION_LIVE_TIMEOUT_MS || 30000);
    const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0 ? configuredTimeoutMs : 30000;
    const extensionPath = normalizeExtensionPath(env.RECURSION_SILLYTAVERN_EXTENSION_PATH || DEFAULT_RECURSION_EXTENSION_PATH);
    let session = null;
    try {
      session = createSillyTavernHttpSession({
        baseUrl: env.SILLYTAVERN_BASE_URL,
        user: userResult.user,
        password: passwordForUser(userResult.user, env),
        fetchImpl
      });
      await session.init();
      await session.login();
      event('auth', 'pass', 'Dedicated SillyTavern user authenticated.', { user: userResult.user });
      addCheck(report, {
        name: 'sillytavern-auth',
        status: 'pass',
        summary: 'Dedicated SillyTavern user authenticated.'
      });

      const served = await compareServedRecursionExtension({
        baseUrl: env.SILLYTAVERN_BASE_URL,
        extensionPath,
        localRoot,
        headers: session.authHeaders(),
        fetchImpl,
        timeoutMs
      });
      report.extension = served;
      const servedAllowsBrowser = served.ok;
      addCheck(report, {
        name: 'served-extension-freshness',
        status: served.ok ? 'pass' : served.status,
        summary: served.ok
          ? 'Served Recursion extension files match the checkout.'
          : served.servedStatus === 'served-extension-mismatch'
          ? 'Served Recursion extension files do not match the checkout.'
          : 'Served Recursion extension files are unavailable.',
        details: {
          servedStatus: served.servedStatus,
          extensionPath: served.extensionPath,
          mismatchCount: served.mismatchCount,
          servedFailureCount: served.servedFailureCount,
          missingLocalCount: served.missingLocalCount
        }
      });
      event('served-extension', servedAllowsBrowser ? 'pass' : served.status, served.servedStatus, {
        extensionPath: served.extensionPath,
        mismatchCount: served.mismatchCount,
        servedFailureCount: served.servedFailureCount
      });
      if (artifactLocation?.ok) {
        const servedPath = writeJsonArtifact(report, artifactLocation, 'host-extensions/served-extension-compare.json', served);
        if (!servedPath) {
          const error = new Error('Served-extension artifact write failed.');
          error.status = 'environment-fail';
          error.result = 'artifact-write-failed';
          throw error;
        }
        report.artifacts = { ...(report.artifacts || {}), servedExtension: servedPath };
      }

      if (!servedAllowsBrowser) {
        setReportStatus(report, served.status, served.result);
        report.nextAction = served.servedStatus === 'served-extension-mismatch'
          ? 'Sync the installed SillyTavern Recursion extension copy to this checkout before running browser smoke.'
          : 'Install Recursion for the dedicated recursion-soak-* SillyTavern user before running browser smoke.';
      } else {
        const storageProbe = await runStorageProbeSuite({
          baseUrl: env.SILLYTAVERN_BASE_URL,
          users: [userResult.user],
          env,
          fetchImpl,
          runId: report.runId
        });
        report.storageProbe = storageProbe;
        for (const warning of storageProbe.warnings || []) report.warnings.push(warning);
        addCheck(report, {
          name: 'storage-isolation-probe',
          status: storageProbe.status,
          summary: storageProbe.status === 'pass'
            ? 'Dedicated-user storage probe completed.'
            : 'Dedicated-user storage probe failed before browser smoke.',
          details: {
            result: storageProbe.result,
            users: storageProbe.users,
            probeCount: storageProbe.probes?.length || 0,
            isolationChecks: storageProbe.isolationChecks?.length || 0,
            cleanup: storageProbe.cleanup || [],
            error: storageProbe.error
          }
        });
        event('storage-probe', storageProbe.status, storageProbe.result, {
          users: storageProbe.users,
          probeCount: storageProbe.probes?.length || 0,
          cleanup: storageProbe.cleanup || []
        });
        if (artifactLocation?.ok) {
          const probePath = writeJsonArtifact(report, artifactLocation, 'storage/probe.json', storageProbe);
          if (!probePath) {
            const error = new Error('Storage probe artifact write failed.');
            error.status = 'environment-fail';
            error.result = 'artifact-write-failed';
            throw error;
          }
          report.artifacts = { ...(report.artifacts || {}), storageProbe: probePath };
        }
        if (storageProbe.status !== 'pass') {
          setReportStatus(report, storageProbe.status, storageProbe.result);
          report.nextAction = 'Create dedicated recursion-soak-* users, verify credentials and file-storage access, then rerun live smoke.';
        } else {
          const generationRequested = env.RECURSION_LIVE_GENERATION === '1' || env.RECURSION_LIVE_REASONER === '1';
          const reasonerRequested = env.RECURSION_LIVE_REASONER === '1';
          const browserResult = await runBrowserUiSmoke({
            baseUrl: env.SILLYTAVERN_BASE_URL,
            cookies: session.playwrightCookies(),
            artifactLocation: artifactLocation?.ok ? artifactLocation : null,
            timeoutMs,
            env,
            generationRequested,
            reasonerRequested
          });
          lastBrowserResult = browserResult;
          report.browser = browserResult;
          if (browserResult.artifacts && Object.keys(browserResult.artifacts).length > 0) {
            report.artifacts = { ...(report.artifacts || {}), ...browserResult.artifacts };
          }
          if (artifactLocation?.ok) {
            const browserPath = writeJsonArtifact(report, artifactLocation, 'browser/snapshot.json', browserResult);
            if (!browserPath) {
              const error = new Error('Browser snapshot artifact write failed.');
              error.status = 'environment-fail';
              error.result = 'artifact-write-failed';
              throw error;
            }
            report.artifacts = { ...(report.artifacts || {}), browserSnapshot: browserPath };
          }
          addCheck(report, {
            name: 'browser-live-smoke',
            status: browserResult.status,
            summary: browserResult.status === 'pass'
              ? 'Recursion bar, progress menu, Last Brief dropdown, settings, viewer access, and bridge hooks were visible in SillyTavern.'
              : 'Recursion browser UI smoke failed.',
            details: {
              result: browserResult.result,
              rootMounted: browserResult.snapshot?.rootMounted,
              barVisible: browserResult.snapshot?.barVisible,
              actionMenuOpen: browserResult.snapshot?.actionMenuOpen,
              settingsPanelOpen: browserResult.snapshot?.settingsPanelOpen,
              providerTestVisible: browserResult.snapshot?.providerTestVisible,
              generation: browserResult.snapshot?.generation
                ? {
                    requested: browserResult.snapshot.generation.requested,
                    reasonerRequested: browserResult.snapshot.generation.reasonerRequested,
                    triggerSource: browserResult.snapshot.generation.triggerSource,
                    chatMutationSource: browserResult.snapshot.generation.chatMutationSource,
                    hostGenerationContinued: browserResult.snapshot.generation.hostGenerationContinued,
                    manualProof: browserResult.snapshot.generation.manualProof
                      ? {
                          ok: browserResult.snapshot.generation.manualProof.ok === true,
                          mode: browserResult.snapshot.generation.manualProof.mode || '',
                          observedMode: browserResult.snapshot.generation.manualProof.observedMode || '',
                          modeApplied: browserResult.snapshot.generation.manualProof.modeApplied === true,
                          promptInstalled: browserResult.snapshot.generation.manualProof.promptInstalled === true
                        }
                      : null,
                    manualScopeProof: browserResult.snapshot.generation.manualScopeProof
                      ? {
                          available: browserResult.snapshot.generation.manualScopeProof.available === true,
                          disabledFamily: browserResult.snapshot.generation.manualScopeProof.disabledFamily || '',
                          disabled: browserResult.snapshot.generation.manualScopeProof.disabled === true,
                          promptRespectsDisabledFamily: browserResult.snapshot.generation.manualScopeProof.promptRespectsDisabledFamily === null ? null : browserResult.snapshot.generation.manualScopeProof.promptRespectsDisabledFamily === true
                        }
                      : null,
                    interceptorOk: browserResult.snapshot.generation.interceptorOk,
                    promptRecorderOk: browserResult.snapshot.generation.promptRecorderOk,
                    promptInstalled: browserResult.snapshot.generation.promptInstalled,
                    handReady: browserResult.snapshot.generation.handReady,
                    promptPacketVisible: browserResult.snapshot.generation.promptPacketVisible,
                    promptKeys: browserResult.snapshot.generation.promptKeys,
                    promptEventCount: browserResult.snapshot.generation.promptEventCount
                  }
                : null,
              handOpen: browserResult.snapshot?.handOpen,
              viewerOpen: browserResult.snapshot?.viewerOpen,
              bridge: browserResult.snapshot?.bridge,
              error: browserResult.error,
              consoleCount: browserResult.consoleMessages?.length || 0,
              pageErrorCount: browserResult.pageErrors?.length || 0
            }
          });
          event('browser-ui', browserResult.status, browserResult.result, {
            rootMounted: browserResult.snapshot?.rootMounted,
            barVisible: browserResult.snapshot?.barVisible,
            actionMenuOpen: browserResult.snapshot?.actionMenuOpen,
            settingsPanelOpen: browserResult.snapshot?.settingsPanelOpen,
            providerTestVisible: browserResult.snapshot?.providerTestVisible,
            generation: browserResult.snapshot?.generation
              ? {
                  requested: browserResult.snapshot.generation.requested,
                  reasonerRequested: browserResult.snapshot.generation.reasonerRequested,
                  triggerSource: browserResult.snapshot.generation.triggerSource,
                  chatMutationSource: browserResult.snapshot.generation.chatMutationSource,
                  hostGenerationContinued: browserResult.snapshot.generation.hostGenerationContinued,
                  manualProof: browserResult.snapshot.generation.manualProof
                    ? {
                        ok: browserResult.snapshot.generation.manualProof.ok === true,
                        mode: browserResult.snapshot.generation.manualProof.mode || '',
                        observedMode: browserResult.snapshot.generation.manualProof.observedMode || '',
                        modeApplied: browserResult.snapshot.generation.manualProof.modeApplied === true,
                        promptInstalled: browserResult.snapshot.generation.manualProof.promptInstalled === true
                      }
                    : null,
                  manualScopeProof: browserResult.snapshot.generation.manualScopeProof
                    ? {
                        available: browserResult.snapshot.generation.manualScopeProof.available === true,
                        disabledFamily: browserResult.snapshot.generation.manualScopeProof.disabledFamily || '',
                        disabled: browserResult.snapshot.generation.manualScopeProof.disabled === true,
                        promptRespectsDisabledFamily: browserResult.snapshot.generation.manualScopeProof.promptRespectsDisabledFamily === null ? null : browserResult.snapshot.generation.manualScopeProof.promptRespectsDisabledFamily === true
                      }
                    : null,
                  promptInstalled: browserResult.snapshot.generation.promptInstalled,
                  handReady: browserResult.snapshot.generation.handReady,
                  promptPacketVisible: browserResult.snapshot.generation.promptPacketVisible
                }
              : null,
            handOpen: browserResult.snapshot?.handOpen,
            viewerOpen: browserResult.snapshot?.viewerOpen
          });
          if (browserResult.status === 'pass' && generationRequested) {
            const generationEvidence = browserResult.snapshot?.generation || null;
            const directBridgeDiagnostic = report.strict === true && generationEvidence?.triggerSource === 'direct-bridge';
            const generationProofStatus = generationEvidence?.promptInstalled && !directBridgeDiagnostic ? 'pass' : 'fail';
            const generationProofResult = directBridgeDiagnostic
              ? 'generation-direct-bridge-diagnostic'
              : browserResult.result;
            addCheck(report, {
              name: 'generation-live-smoke',
              status: generationProofStatus,
              summary: directBridgeDiagnostic
                ? 'Direct bridge fallback is diagnostic only; strict generation proof requires visible send controls.'
                : generationEvidence?.promptInstalled
                  ? 'Generation bridge installed a Recursion prompt packet through the live extension.'
                  : 'Generation bridge did not produce prompt-install evidence.',
              details: {
                liveGeneration: env.RECURSION_LIVE_GENERATION === '1',
                liveReasoner: env.RECURSION_LIVE_REASONER === '1',
                releaseProof: generationProofStatus === 'pass',
                diagnosticOnly: directBridgeDiagnostic,
                generation: generationEvidence
              }
            });
            event('generation-live-smoke', generationProofStatus, generationProofResult, {
              liveGeneration: env.RECURSION_LIVE_GENERATION === '1',
              liveReasoner: env.RECURSION_LIVE_REASONER === '1',
              releaseProof: generationProofStatus === 'pass',
              diagnosticOnly: directBridgeDiagnostic,
              generation: generationEvidence
            });
            setReportStatus(report, generationProofStatus, generationProofResult);
            report.nextAction = directBridgeDiagnostic
              ? 'Run generation-enabled strict smoke against a Recursion-enabled chat with visible SillyTavern input and send controls; direct bridge evidence is diagnostic only.'
              : generationEvidence?.promptInstalled
                ? 'Generation-enabled Recursion bridge smoke passed. Inspect sanitized prompt-key, host-continuation, prompt-metadata, and activity evidence before treating this as host-quality proof.'
                : 'Inspect generation bridge evidence, prompt recorder status, prompt metadata, activity latest-run, and console/page errors.';
          } else {
            setReportStatus(report, browserResult.status, browserResult.result);
            if (generationRequested) {
              report.nextAction = 'Inspect browser snapshot, generation evidence, prompt metadata, activity latest-run, and console/page errors.';
            } else {
              report.nextAction = browserResult.status === 'pass'
                ? 'No-generation Recursion UI smoke passed; generation-enabled smoke remains a separate opt-in gate.'
                : 'Inspect browser snapshot, screenshots, and console/page errors before running generation-enabled smoke.';
            }
          }
        }
      }
    } catch (error) {
      const status = error?.status || 'environment-fail';
      const result = error?.result || 'live-smoke-failed';
      event('live-smoke', status, result, { error: compactBrowserIssue(error) });
      addCheck(report, {
        name: 'live-smoke-runtime',
        status,
        summary: 'Live smoke failed before browser checks completed.',
        details: {
          result,
          httpStatus: error?.httpStatus,
          error: compactBrowserIssue(error)
        }
      });
      setReportStatus(report, status, result);
      report.nextAction = result === 'login-failed'
        ? 'Create the dedicated recursion-soak-* SillyTavern user or correct its password, then rerun live smoke.'
        : 'Inspect the live smoke runtime failure and rerun after the environment issue is corrected.';
    } finally {
      if (artifactLocation?.ok) {
        if (lastBrowserResult) {
          const artifactStatusReport = finalizeReport(report);
          const promptMetadataPath = writeJsonArtifact(
            artifactStatusReport,
            artifactLocation,
            'prompt/latest-packet-metadata.json',
            promptMetadataFromBrowserResult(artifactStatusReport, lastBrowserResult)
          );
          if (promptMetadataPath) report.artifacts = { ...(report.artifacts || {}), promptMetadata: promptMetadataPath };
          const activityPath = writeJsonArtifact(
            artifactStatusReport,
            artifactLocation,
            'activity/latest-run.json',
            activityLatestRunFromReport(artifactStatusReport, liveLog, lastBrowserResult)
          );
          if (activityPath) report.artifacts = { ...(report.artifacts || {}), activityLatestRun: activityPath };
        }
        const liveLogPath = writeTextArtifact(
          report,
          artifactLocation,
          'live-log.jsonl',
          `${liveLog.map((entry) => JSON.stringify(redactHarnessValue(entry))).join('\n')}${liveLog.length ? '\n' : ''}`
        );
        if (liveLogPath) report.artifacts = { ...(report.artifacts || {}), liveLog: liveLogPath };
      }
      if (typeof session?.close === 'function') await session.close();
    }
  }

  report = finalizeReport(report);
  if (args.writeArtifacts) report = attachReportArtifacts(report, { artifactRoot, family: 'live-smoke/sillytavern' });
  return report;
}

export function isDirectRun(metaUrl, argv = process.argv) {
  return metaUrl === pathToFileURL(argv[1] || '').href;
}

export function printReportAndSetExitCode(report, { stdout = process.stdout } = {}) {
  stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = exitCodeForReport(report);
}
