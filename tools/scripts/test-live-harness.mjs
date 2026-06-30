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
