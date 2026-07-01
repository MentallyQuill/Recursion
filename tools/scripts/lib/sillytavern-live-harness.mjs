import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
  const files = [...new Set([
    'manifest.json',
    ...manifestFiles,
    'src/extension/index.js',
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
    message: sanitizeHarnessText(error?.message || String(error || ''), 240)
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
      handText: text('[data-recursion-hand-count]'),
      composerText: text('[data-recursion-composer]'),
      reasonerText: text('[data-recursion-reasoner]'),
      ribbonText: text('[data-recursion-ribbon-label]'),
      handOpen: document.querySelector('[data-recursion-hand-dropdown]')?.hidden === false,
      viewerOpen: Boolean(document.querySelector('[data-recursion-viewer]')?.open) || document.querySelector('[data-recursion-viewer]')?.hidden === false,
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

async function runBrowserUiSmoke({
  baseUrl,
  cookies = [],
  artifactLocation = null,
  timeoutMs = 30000,
  env = {}
} = {}) {
  const consoleMessages = [];
  const pageErrors = [];
  let browser = null;
  let context = null;
  let page = null;
  let traceStarted = false;
  const artifacts = {};

  async function captureFailureArtifacts() {
    if (!artifactLocation || !page) return;
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
    if (artifactLocation) {
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

    const handButton = page.locator('[data-recursion-hand-toggle]').first();
    await handButton.click({ timeout: timeoutMs });
    await page.waitForFunction(() => document.querySelector('[data-recursion-hand-dropdown]')?.hidden === false, null, { timeout: timeoutMs });

    const viewerButton = page.locator('[data-recursion-viewer-toggle]').first();
    await viewerButton.click({ timeout: timeoutMs });
    await page.waitForFunction(() => {
      const viewer = document.querySelector('[data-recursion-viewer]');
      return Boolean(viewer && (viewer.open || viewer.hidden === false));
    }, null, { timeout: timeoutMs });

    const snapshot = await page.evaluate(browserSnapshotScript());
    if (!snapshot.rootMounted || !snapshot.barVisible || !snapshot.bridge?.interceptor || !snapshot.bridge?.enableHook || !snapshot.bridge?.disableHook) {
      const error = new Error('Recursion UI bridge assertion failed.');
      error.status = 'fail';
      error.result = 'browser-smoke-assertion-failed';
      throw error;
    }
    if (artifactLocation) {
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

    await context.close();
    return {
      status: 'pass',
      result: 'browser-smoke-pass',
      snapshot,
      consoleMessages: consoleMessages.slice(-20),
      pageErrors: pageErrors.slice(-20),
      artifacts
    };
  } catch (error) {
    await captureFailureArtifacts();
    await stopTraceArtifact();
    return {
      status: error?.status || (error?.name === 'TimeoutError' ? 'fail' : 'environment-fail'),
      result: error?.result || (error?.name === 'TimeoutError' ? 'browser-smoke-timeout' : 'browser-smoke-failed'),
      error: compactBrowserIssue(error),
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

export function attachReportArtifacts(report, options = {}) {
  try {
    writeReportArtifacts(report, options);
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
          const browserResult = await runBrowserUiSmoke({
            baseUrl: env.SILLYTAVERN_BASE_URL,
            cookies: session.playwrightCookies(),
            artifactLocation: artifactLocation?.ok ? artifactLocation : null,
            timeoutMs,
            env
          });
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
              ? 'Recursion bar, hand dropdown, viewer, and bridge hooks were visible in SillyTavern.'
              : 'Recursion browser UI smoke failed.',
            details: {
              result: browserResult.result,
              rootMounted: browserResult.snapshot?.rootMounted,
              barVisible: browserResult.snapshot?.barVisible,
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
            handOpen: browserResult.snapshot?.handOpen,
            viewerOpen: browserResult.snapshot?.viewerOpen
          });
          setReportStatus(report, browserResult.status, browserResult.result);
          report.nextAction = browserResult.status === 'pass'
            ? 'No-generation Recursion UI smoke passed; generation-enabled smoke remains a separate opt-in gate.'
            : 'Inspect browser snapshot, screenshots, and console/page errors before running generation-enabled smoke.';
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
