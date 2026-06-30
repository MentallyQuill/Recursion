import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addCheck,
  createBaseReport,
  exitCodeForReport,
  finalizeReport,
  normalizeSoakUserHandle,
  rejectUnsafeLiveUser,
  reportToSummary,
  runPlaywrightReadiness,
  runSillyTavernLiveSmoke,
  runSoakUsersPreflight,
  setReportStatus,
  validateSoakUserHandle,
  validateSoakUserList
} from './lib/sillytavern-live-harness.mjs';
import { assert, assertDeepEqual, assertEqual, assertRejects } from '../../tests/helpers/assert.mjs';

function createJsonResponse(status, value, headers = {}) {
  const text = value === undefined ? '' : JSON.stringify(value);
  const lowerHeaders = Object.fromEntries(Object.entries(headers).map(([key, headerValue]) => [key.toLowerCase(), headerValue]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        return lowerHeaders[String(name).toLowerCase()] ?? null;
      },
      getSetCookie() {
        const value = lowerHeaders['set-cookie'];
        return value ? [value] : [];
      }
    },
    async text() {
      return text;
    }
  };
}

function createFakeSillyTavernFetch({ users = {}, failDeleteFor = [] } = {}) {
  const state = {
    calls: [],
    failDeleteFor: new Set(failDeleteFor),
    sessions: new Map(),
    users: Object.fromEntries(Object.entries(users).map(([handle, config]) => [handle, {
      password: config.password || '',
      files: new Map()
    }]))
  };
  let nextSession = 1;

  function sessionFromHeaders(headers = {}) {
    const cookie = headers.Cookie || headers.cookie || '';
    const match = String(cookie).match(/sid=([^;]+)/);
    if (match && state.sessions.has(match[1])) return state.sessions.get(match[1]);
    const sid = `session-${nextSession++}`;
    const session = { sid, csrf: `csrf-${sid}`, user: null };
    state.sessions.set(sid, session);
    return session;
  }

  function requireCsrf(session, headers = {}) {
    return (headers['X-CSRF-Token'] || headers['x-csrf-token']) === session.csrf;
  }

  function requireUser(session) {
    return session.user && state.users[session.user] ? state.users[session.user] : null;
  }

  async function fetchImpl(url, options = {}) {
    const parsed = new URL(url);
    const pathName = parsed.pathname;
    const method = options.method || 'GET';
    const headers = options.headers || {};
    const body = options.body ? JSON.parse(options.body) : {};
    const session = sessionFromHeaders(headers);
    state.calls.push({ method, pathName, user: session.user, body, cookie: headers.Cookie || headers.cookie || '' });

    if (method === 'GET' && pathName === '/csrf-token') {
      return createJsonResponse(200, { token: session.csrf }, { 'set-cookie': `sid=${session.sid}; Path=/; HttpOnly` });
    }

    if (method === 'POST' && pathName === '/api/users/login') {
      if (!requireCsrf(session, headers)) return createJsonResponse(403, { error: 'bad csrf' });
      const user = state.users[body.handle];
      if (!user || user.password !== (body.password || '')) return createJsonResponse(403, { error: 'bad credentials' });
      session.user = body.handle;
      return createJsonResponse(200, { handle: body.handle });
    }

    if (!requireCsrf(session, headers) && method === 'POST') return createJsonResponse(403, { error: 'bad csrf' });
    const user = requireUser(session);
    if (!user) return createJsonResponse(403, { error: 'not logged in' });

    if (method === 'POST' && pathName === '/api/files/upload') {
      user.files.set(body.name, Buffer.from(body.data, 'base64').toString('utf8'));
      return createJsonResponse(200, { path: `/user/files/${body.name}` });
    }

    if (method === 'POST' && pathName === '/api/files/verify') {
      return createJsonResponse(200, Object.fromEntries((body.urls || []).map((entry) => {
        const fileName = decodeURIComponent(String(entry).replace('/user/files/', ''));
        return [entry, user.files.has(fileName)];
      })));
    }

    if (method === 'GET' && pathName.startsWith('/user/files/')) {
      const fileName = decodeURIComponent(pathName.slice('/user/files/'.length));
      if (!user.files.has(fileName)) return createJsonResponse(404, { error: 'missing' });
      return createJsonResponse(200, JSON.parse(user.files.get(fileName)));
    }

    if (method === 'POST' && pathName === '/api/files/delete') {
      const fileName = decodeURIComponent(String(body.path || '').replace('/user/files/', ''));
      if (state.failDeleteFor.has(fileName) || [...state.failDeleteFor].some((entry) => fileName.includes(entry))) {
        return createJsonResponse(500, { error: 'delete failed' });
      }
      if (!user.files.has(fileName)) return createJsonResponse(404, { error: 'missing' });
      user.files.delete(fileName);
      return createJsonResponse(200, {});
    }

    return createJsonResponse(404, { error: 'unknown endpoint' });
  }

  return { fetchImpl, state };
}

assertEqual(normalizeSoakUserHandle(' Recursion-Soak-A '), 'recursion-soak-a', 'user handles normalize to trimmed lowercase');
assertDeepEqual(validateSoakUserHandle('recursion-soak-a').ok, true, 'recursion soak user accepted');
assertEqual(validateSoakUserHandle('default-user').status, 'unsafe-user', 'default-user rejected');
assertEqual(validateSoakUserHandle('default').reason, 'default-profile-alias', 'default alias rejected');
assertEqual(validateSoakUserHandle('directive-soak-a').reason, 'non-dedicated-user', 'non-recursion soak rejected');
assertEqual(validateSoakUserHandle('').reason, 'missing-user', 'empty user rejected');
assertEqual(validateSoakUserList('recursion-soak-a, recursion-soak-b').status, 'pass', 'safe user list passes');
assertEqual(validateSoakUserList('recursion-soak-a, default-user').status, 'unsafe-user', 'mixed unsafe user list fails');
assertEqual(validateSoakUserList('recursion-soak-a, recursion-soak-a').failed[0].reason, 'duplicate-user', 'duplicate soak users rejected');
await assertRejects(() => rejectUnsafeLiveUser('default-user'), /Unsafe SillyTavern live-test user/, 'rejectUnsafeLiveUser throws on default-user');

{
  const report = await runSoakUsersPreflight({
    argv: [],
    env: {}
  });
  assertEqual(report.status, 'skipped', 'soak preflight with no users is a dry-run checklist');
  assert(report.checks.some((check) => check.name === 'dedicated-user-policy' && check.status === 'skipped'), 'missing users are skipped in dry-run mode');
}

{
  const report = await runSoakUsersPreflight({
    argv: [],
    env: {
      RECURSION_SOAK_ST_USERS: 'recursion-soak-a,recursion-soak-b',
      SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000'
    }
  });
  assertEqual(report.status, 'skipped', 'soak preflight dry run is skipped');
  assertEqual(report.result, 'dry-run', 'soak preflight dry run result');
  assert(report.checks.some((check) => check.name === 'live-mutation' && check.status === 'skipped'), 'dry run reports no mutation');
}

{
  const report = await runSoakUsersPreflight({
    argv: ['--live'],
    env: {
      RECURSION_SOAK_ST_USERS: 'default-user',
      SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000'
    }
  });
  assertEqual(report.status, 'unsafe-user', 'live soak preflight rejects default-user before mutation');
  assert(!report.checks.some((check) => check.name === 'storage-isolation-probe'), 'unsafe users stop before storage probe');
}

{
  const report = await runSoakUsersPreflight({
    argv: ['--live'],
    env: {
      RECURSION_SOAK_ST_USERS: 'recursion-soak-a'
    }
  });
  assertEqual(report.status, 'environment-fail', 'live soak preflight requires base url after safe user passes');
  assert(report.checks.some((check) => check.name === 'base-url'), 'base url check is reported');
}

{
  const fakeHost = createFakeSillyTavernFetch({
    users: {
      'recursion-soak-a': {},
      'recursion-soak-b': { password: 'shared-secret' }
    }
  });
  const artifactRoot = mkdtempSync(join(tmpdir(), 'recursion-storage-probe-'));
  try {
    const report = await runSoakUsersPreflight({
      argv: ['--live', '--write-artifacts'],
      env: {
        SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000',
        RECURSION_SOAK_ST_USERS: 'recursion-soak-a,recursion-soak-b',
        RECURSION_SILLYTAVERN_PASSWORD_RECURSION_SOAK_B: 'shared-secret'
      },
      artifactRoot,
      fetchImpl: fakeHost.fetchImpl
    });
    assertEqual(report.status, 'pass', 'storage probe passes for two dedicated users');
    assertEqual(report.result, 'storage-probe-pass', 'storage probe result is explicit');
    assertEqual(report.storageProbe.probes.length, 2, 'storage probe writes one probe per user');
    assertEqual(report.storageProbe.isolationChecks.length, 2, 'storage probe checks cross-user isolation in both directions');
    assert(report.storageProbe.cleanup.every((entry) => entry.status === 'deleted'), 'storage probe cleanup deletes all probe files');
    const authenticatedCall = fakeHost.state.calls.find((entry) => entry.pathName === '/api/files/upload');
    assert(authenticatedCall.cookie.includes('sid=session-'), 'authenticated storage calls send a session cookie');
    assert(!authenticatedCall.cookie.includes('Path='), 'authenticated storage calls do not echo cookie attributes');
    assert(!authenticatedCall.cookie.includes('HttpOnly'), 'authenticated storage calls keep HttpOnly out of Cookie headers');
    assertDeepEqual([...fakeHost.state.users['recursion-soak-a'].files.keys()], [], 'soak-a probe files cleaned up');
    assertDeepEqual([...fakeHost.state.users['recursion-soak-b'].files.keys()], [], 'soak-b probe files cleaned up');
    assertEqual(report.artifacts.storageProbe, 'storage/probe.json', 'storage probe artifact path is relative');
    const runRoot = join(artifactRoot, 'live-smoke', 'sillytavern', report.runId);
    const probeArtifact = readFileSync(join(runRoot, 'storage', 'probe.json'), 'utf8');
    assert(probeArtifact.includes('"storage-probe-pass"'), 'storage probe artifact persisted');
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
}

{
  const fakeHost = createFakeSillyTavernFetch({ users: {} });
  const report = await runSoakUsersPreflight({
    argv: ['--live'],
    env: {
      SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000',
      RECURSION_SOAK_ST_USERS: 'recursion-soak-a'
    },
    fetchImpl: fakeHost.fetchImpl
  });
  assertEqual(report.status, 'environment-fail', 'missing soak user fails through login');
  assertEqual(report.result, 'login-failed', 'missing soak user reports login failure');
  assertEqual(report.storageProbe.probes.length, 0, 'login failure writes no probe files');
}

{
  const fakeHost = createFakeSillyTavernFetch({
    users: {
      'recursion-soak-a': {}
    }
  });
  const report = await runSoakUsersPreflight({
    argv: ['--live'],
    env: {
      SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000',
      RECURSION_SOAK_ST_USERS: 'recursion-soak-a,recursion-soak-b'
    },
    fetchImpl: fakeHost.fetchImpl
  });
  assertEqual(report.status, 'environment-fail', 'mixed existing and missing users fail before mutation');
  assertEqual(report.result, 'login-failed', 'mixed missing user reports login failure');
  assertEqual(report.storageProbe.probes.length, 0, 'mixed missing user writes no probe files before all users authenticate');
  assertDeepEqual([...fakeHost.state.users['recursion-soak-a'].files.keys()], [], 'authenticated earlier user has no probe file after later login failure');
}

{
  const fakeHost = createFakeSillyTavernFetch({
    users: {
      'recursion-soak-a': {}
    },
    failDeleteFor: ['recursion-soak-a']
  });
  const report = await runSoakUsersPreflight({
    argv: ['--live'],
    env: {
      SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000',
      RECURSION_SOAK_ST_USERS: 'recursion-soak-a'
    },
    fetchImpl: fakeHost.fetchImpl
  });
  assertEqual(report.status, 'fail', 'cleanup failure fails storage probe run');
  assertEqual(report.result, 'storage-probe-cleanup-failed', 'cleanup failure result is explicit');
  assert(report.storageProbe.cleanup.some((entry) => entry.status === 'failed'), 'cleanup failure recorded');
  assert([...fakeHost.state.users['recursion-soak-a'].files.keys()].length > 0, 'test simulates leaked probe file on cleanup failure');
}

{
  const report = await runSillyTavernLiveSmoke({
    argv: [],
    env: {}
  });
  assertEqual(report.status, 'skipped', 'live smoke with no user is a dry-run checklist');
  assert(report.checks.some((check) => check.name === 'dedicated-user-policy' && check.status === 'skipped'), 'missing smoke user is skipped in dry-run mode');
}

{
  const report = await runSillyTavernLiveSmoke({
    argv: ['--live'],
    env: {
      RECURSION_SILLYTAVERN_USER: 'default-user',
      SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000'
    }
  });
  assertEqual(report.status, 'unsafe-user', 'live smoke rejects default-user');
  assert(!report.checks.some((check) => check.name === 'browser-live-smoke'), 'unsafe user stops before browser smoke');
}

{
  const report = await runSillyTavernLiveSmoke({
    argv: [],
    env: {
      RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
      SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000'
    }
  });
  assertEqual(report.status, 'skipped', 'live smoke dry run is skipped');
  assertEqual(report.user, 'recursion-soak-a', 'dry run records safe user');
}

{
  const report = await runSillyTavernLiveSmoke({
    argv: ['--live', '--dry-run'],
    env: {
      RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
      SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000'
    }
  });
  assertEqual(report.status, 'skipped', 'dry-run overrides live flag');
  assertEqual(report.mode, 'dry-run', 'dry-run override reports dry-run mode');
  assertEqual(report.dryRun, true, 'dry-run override records dryRun true');
  assert(report.warnings.some((warning) => warning.name === 'dry-run-override'), 'dry-run override reports warning');
}

{
  const report = await runSillyTavernLiveSmoke({
    argv: ['--live', '--dry-run'],
    env: {
      RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
      SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000',
      RECURSION_LIVE_STRICT: '1'
    }
  });
  assertEqual(report.status, 'fail', 'strict mode promotes dry-run override warning to failure');
  assertEqual(report.result, 'strict-warning', 'strict warning result is explicit');
  assertEqual(report.dryRun, true, 'strict dry-run override still prevents live mutation');
  assertEqual(exitCodeForReport(report), 1, 'strict warning failure exits nonzero');
  assert(report.failures.some((failure) => failure.name === 'dry-run-override'), 'strict mode reports warning as failure');
}

{
  const report = await runSillyTavernLiveSmoke({
    argv: [],
    env: {
      RECURSION_LIVE_STRICT: '1'
    }
  });
  assertEqual(report.strict, true, 'RECURSION_LIVE_STRICT enables strict mode');
}

{
  const report = await runPlaywrightReadiness({
    argv: ['--dry-run'],
    env: {}
  });
  assertEqual(report.status, 'skipped', 'playwright dry run skips browser launch');
  assert(report.checks.some((check) => check.name === 'sillytavern-contact' && check.status === 'pass'), 'readiness documents no SillyTavern contact');
}

{
  const artifactRoot = mkdtempSync(join(tmpdir(), 'recursion-readiness-'));
  try {
    const report = await runPlaywrightReadiness({
      argv: ['--write-artifacts'],
      env: {},
      artifactRoot
    });
    assertEqual(report.status, 'pass', 'real Playwright readiness passes');
    assertEqual(report.result, 'readiness-pass', 'real readiness result is explicit');
    assertDeepEqual(report.artifacts, {
      desktopScreenshot: 'screenshots/desktop.png',
      phoneScreenshot: 'screenshots/phone.png',
      trace: 'playwright/trace.zip',
      summary: 'summary.md',
      report: 'report.json'
    }, 'readiness artifact paths are relative to run root');
    const runRoot = join(artifactRoot, 'playwright-readiness', report.runId);
    const persisted = readFileSync(join(runRoot, 'report.json'), 'utf8');
    const summary = readFileSync(join(runRoot, 'summary.md'), 'utf8');
    assert(persisted.includes('"readiness-pass"'), 'readiness report persisted');
    assert(summary.includes('Playwright readiness passed'), 'readiness summary includes next action');
    assert(readFileSync(join(runRoot, 'screenshots', 'desktop.png')).length > 0, 'desktop screenshot written');
    assert(readFileSync(join(runRoot, 'screenshots', 'phone.png')).length > 0, 'phone screenshot written');
    assert(readFileSync(join(runRoot, 'playwright', 'trace.zip')).length > 0, 'trace written');
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
}

{
  const report = createBaseReport({ scriptName: 'redaction-check', args: {}, env: {} });
  addCheck(report, {
    name: 'secret-message',
    status: 'environment-fail',
    summary: 'Authorization: Bearer sk-live-secret and password=hunter2',
    details: {
      message: 'Provider returned Authorization: Bearer sk-live-secret with apiKey=abc123 and sessionId=sess-12345',
      sessionId: 'sess-field-12345',
      sid: 'sid-field-12345',
      sessionCount: 2
    }
  });
  setReportStatus(report, 'environment-fail', 'redaction-check');
  report.nextAction = 'Remove token=abc123, sid=nav-12345, and sk-live-secret from logs.';
  const finalized = finalizeReport(report);
  const serialized = JSON.stringify(finalized);
  const summary = reportToSummary(finalized);
  assert(!serialized.includes('sk-live-secret'), 'report redacts sk-style values inside strings');
  assert(!serialized.includes('abc123'), 'report redacts token-like values inside strings');
  assert(!serialized.includes('hunter2'), 'report redacts password-like values inside strings');
  assert(!serialized.includes('sess-12345'), 'report redacts sessionId-like values inside strings');
  assert(!serialized.includes('sess-field-12345'), 'report redacts sessionId fields');
  assert(!serialized.includes('sid-field-12345'), 'report redacts sid fields');
  assertEqual(finalized.checks[0].details.sessionCount, 2, 'sessionCount metrics are preserved');
  assert(!summary.includes('sk-live-secret'), 'summary redacts sk-style values');
  assert(!summary.includes('abc123'), 'summary redacts token-like values');
  assert(!summary.includes('nav-12345'), 'summary redacts sid-like values');
  assert(summary.includes('[redacted]'), 'summary keeps redaction marker');
}

{
  const artifactRoot = mkdtempSync(join(tmpdir(), 'recursion-harness-'));
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--write-artifacts'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000',
        RECURSION_ARTIFACT_DIR: artifactRoot,
        RECURSION_API_KEY: 'secret-value'
      },
      artifactRoot
    });
    assertEqual(report.status, 'skipped', 'artifact dry run is skipped');
    assertDeepEqual(report.artifacts, { summary: 'summary.md', report: 'report.json' }, 'artifact paths are relative to run root');
    const runRoot = join(artifactRoot, 'live-smoke', 'sillytavern', report.runId);
    const persisted = readFileSync(join(runRoot, 'report.json'), 'utf8');
    const summary = readFileSync(join(runRoot, 'summary.md'), 'utf8');
    assert(!persisted.includes('secret-value'), 'artifact report redacts environment secrets');
    assert(!persisted.includes(artifactRoot), 'artifact report does not store absolute artifact root');
    assert(persisted.includes('"recordType": "recursion.liveHarnessReport"'), 'artifact report uses live harness record type');
    assert(persisted.includes('"artifacts"'), 'persisted artifact report includes artifact metadata');
    assert(summary.includes('## Next Action'), 'summary includes next action section');
    assert(summary.includes('Re-run with --live only after the browser smoke implementation is present.'), 'summary includes actionable next step');
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
}

{
  const artifactRoot = mkdtempSync(join(tmpdir(), 'recursion-harness-'));
  try {
    const blockedRoot = join(artifactRoot, 'not-a-directory');
    writeFileSync(blockedRoot, 'file blocks artifact directory', 'utf8');
    const report = await runSillyTavernLiveSmoke({
      argv: ['--write-artifacts'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000'
      },
      artifactRoot: blockedRoot
    });
    assertEqual(report.status, 'environment-fail', 'artifact write failure returns environment-fail report');
    assertEqual(report.result, 'artifact-write-failed', 'artifact write failure result is explicit');
    assert(!JSON.stringify(report).includes(blockedRoot), 'artifact write failure report avoids absolute failed path');
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
}

{
  const artifactRoot = mkdtempSync(join(tmpdir(), 'recursion-harness-'));
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live', '--write-artifacts'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'default-user',
        SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000'
      },
      artifactRoot
    });
    assertEqual(report.status, 'unsafe-user', 'unsafe artifact run fails closed');
    const runRoot = join(artifactRoot, 'live-smoke', 'sillytavern', report.runId);
    const summary = readFileSync(join(runRoot, 'summary.md'), 'utf8');
    assert(summary.indexOf('## Failures') < summary.indexOf('## Checks'), 'summary lists failures before checks');
    assert(summary.indexOf('## Failures') < summary.indexOf('## Next Action'), 'summary lists failures before next action');
    assert(summary.includes('unsafe-user: dedicated-user-policy'), 'summary includes unsafe-user failure line');
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
}

console.log('[pass] live harness');
