import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { redact, safeId } from '../../../src/core.mjs';

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
  const root = resolve(artifactRoot || process.env.RECURSION_ARTIFACT_DIR || 'artifacts');
  const relativeDirectory = join(family, safeId(report.runId, 'run'));
  const dir = join(root, relativeDirectory);
  const artifactRecord = {
    summary: 'summary.md',
    report: 'report.json'
  };
  mkdirSync(dir, { recursive: true });
  report.artifacts = artifactRecord;
  writeFileSync(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(join(dir, 'summary.md'), reportToSummary(report), 'utf8');
  return artifactRecord;
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

export async function runPlaywrightReadiness({ argv = [], env = process.env, artifactRoot } = {}) {
  const args = parseHarnessArgs(argv);
  let report = createBaseReport({ scriptName: 'check-playwright-readiness', args, env });
  if (args.liveRequested && args.dryRunRequested) {
    report.warnings.push({
      name: 'dry-run-override',
      status: 'warn',
      summary: '--dry-run was provided with --live, so no live browser work will run.'
    });
  }
  report.mode = 'readiness';
  addCheck(report, {
    name: 'sillytavern-contact',
    status: 'pass',
    summary: 'Readiness does not contact SillyTavern or mutate host state.'
  });

  if (!args.live) {
    addCheck(report, {
      name: 'dry-run',
      status: 'skipped',
      summary: 'Playwright launch skipped because this first slice is dependency-light.'
    });
    setReportStatus(report, 'skipped', 'dry-run');
    report.nextAction = 'Implement the real Playwright readiness slice before treating this as browser evidence.';
    report = finalizeReport(report);
    if (args.writeArtifacts) report = attachReportArtifacts(report, { artifactRoot, family: 'playwright-readiness' });
    return report;
  }

  addCheck(report, {
    name: 'browser-control',
    status: 'manual-required',
    summary: 'Real Playwright launch is deferred from this first guardrail slice.'
  });
  setReportStatus(report, 'manual-required', 'playwright-readiness-not-implemented');
  report.nextAction = 'Implement browser launch, role-locator click, screenshots, and trace capture in the next harness slice.';

  report = finalizeReport(report);
  if (args.writeArtifacts) report = attachReportArtifacts(report, { artifactRoot, family: 'playwright-readiness' });
  return report;
}

export async function runSoakUsersPreflight({ argv = [], env = process.env, artifactRoot } = {}) {
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
    report.nextAction = 'Re-run with --live only after dedicated users exist and storage probes are implemented.';
  } else if (!env.SILLYTAVERN_BASE_URL) {
    addCheck(report, {
      name: 'base-url',
      status: 'environment-fail',
      summary: 'SILLYTAVERN_BASE_URL is required for live checks.'
    });
    setReportStatus(report, 'environment-fail', 'missing-base-url');
    report.nextAction = 'Set SILLYTAVERN_BASE_URL before attempting guarded live checks.';
  } else {
    addCheck(report, {
      name: 'storage-isolation-probe',
      status: 'manual-required',
      summary: 'Dedicated-user storage mutation is guarded but not implemented in this slice.'
    });
    setReportStatus(report, 'manual-required', 'storage-probe-not-implemented');
    report.nextAction = 'Implement authenticated user-file storage probes before claiming live isolation evidence.';
  }

  report = finalizeReport(report);
  if (args.writeArtifacts) report = attachReportArtifacts(report, { artifactRoot, family: 'live-smoke/sillytavern' });
  return report;
}

export async function runSillyTavernLiveSmoke({ argv = [], env = process.env, artifactRoot } = {}) {
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
    report.nextAction = 'Re-run with --live only after the browser smoke implementation is present.';
  } else if (!env.SILLYTAVERN_BASE_URL) {
    addCheck(report, {
      name: 'base-url',
      status: 'environment-fail',
      summary: 'SILLYTAVERN_BASE_URL is required for live smoke.'
    });
    setReportStatus(report, 'environment-fail', 'missing-base-url');
    report.nextAction = 'Set SILLYTAVERN_BASE_URL before attempting guarded live smoke.';
  } else {
    addCheck(report, {
      name: 'browser-live-smoke',
      status: 'manual-required',
      summary: 'Live browser smoke is guarded but not implemented in this slice.'
    });
    setReportStatus(report, 'manual-required', 'browser-smoke-not-implemented');
    report.nextAction = 'Implement browser interaction, prompt diagnostics, and cleanup before claiming live smoke evidence.';
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
