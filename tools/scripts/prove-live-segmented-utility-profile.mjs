import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createSillyTavernHttpSession, validateSoakUserHandle } from './lib/sillytavern-live-harness.mjs';
import {
  certifyUtilityProfile,
  contextChatSummaryScript,
  ensureRunnableDeckFixture,
  sendAndWait,
  selectMode,
  selectPipeline,
  selectUtilityProfileByLabel,
  setPower,
  waitForRoot
} from './prove-live-pipelines.mjs';
import {
  ensureSyntheticChat,
  readExecutionSnapshot,
  startFreshSyntheticChat
} from './prove-live-resilience-matrix.mjs';
import { sanitizeResilienceReport } from './lib/live-resilience-matrix-contract.mjs';

export const CYDONIA_PROFILE_LABEL = 'nanogpt TheDrummer/Cydonia-24B-v4.3 - Wandlight-1.3';
const STATE_ROOT = resolve('artifacts', 'live-segmented-utility');
const DEFAULT_TIMEOUT_MS = 300000;

function boundedText(value, length = 500) {
  return String(value ?? '').slice(0, length);
}

function hashIdentity(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function isWithinStateRoot(path) {
  const relation = relative(STATE_ROOT, path);
  return relation === '' || (!relation.startsWith('..') && !resolve(relation).startsWith('\\'));
}

export function parseSegmentedProfileArgs(argv = []) {
  let live = false;
  let statePath = '';
  let profileLabel = CYDONIA_PROFILE_LABEL;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--live') live = true;
    else if (argv[index] === '--state') {
      statePath = resolve(String(argv[index + 1] || ''));
      index += 1;
    } else if (argv[index] === '--profile-label') {
      profileLabel = String(argv[index + 1] || '').trim();
      index += 1;
    }
  }
  if (!live) throw new Error('Pass --live to run the Segmented Utility profile proof.');
  if (!profileLabel) throw new Error('A non-empty profile label is required.');
  if (!statePath || !isWithinStateRoot(statePath) || extname(statePath).toLowerCase() !== '.json') {
    throw new Error('State path must be a JSON file under artifacts/live-segmented-utility.');
  }
  return { live, statePath, profileLabel };
}

export function inspectSegmentedProfileProof({ certification = {}, requestAudit = {}, execution = {}, before = {}, after = {} } = {}) {
  const errors = [];
  if (!['partial', 'pass'].includes(certification.status)) errors.push('segmented-certification-status');
  if (certification.checks?.connectivity !== 'pass') errors.push('connectivity-check');
  if (certification.checks?.singleCard !== 'pass') errors.push('single-card-check');
  if (certification.checks?.fusedCards !== 'not-run') errors.push('fused-check-was-run');
  if (Number(requestAudit.fusedBundleRequests || 0) !== 0) errors.push('fused-request-observed');
  if (execution.state !== 'completed') errors.push('operation-not-completed');
  const stages = Array.isArray(execution.stages) ? execution.stages : [];
  if (stages.some((stage) => String(stage?.stageId || '').includes('.fused'))) errors.push('fused-stage-observed');
  if (!stages.some((stage) => stage?.stageId === 'preprocess.arbiter' && stage?.state === 'completed')) errors.push('arbiter-not-completed');
  if (!stages.some((stage) => String(stage?.stageId || '').includes('preprocess.cards.segmented.') && stage?.state === 'completed')) {
    errors.push('segmented-card-not-completed');
  }
  if (!stages.some((stage) => stage?.stageId === 'preprocess.install' && stage?.state === 'completed')) errors.push('prompt-install-not-completed');
  if (Number(after.userCount || 0) - Number(before.userCount || 0) !== 1) errors.push('user-count-delta');
  if (Number(after.assistantCount || 0) - Number(before.assistantCount || 0) !== 1) errors.push('assistant-count-delta');
  return { ok: errors.length === 0, errors };
}

function passwordForUser(user, env) {
  const key = `RECURSION_SILLYTAVERN_PASSWORD_${String(user).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  return env[key] ?? env.RECURSION_SILLYTAVERN_PASSWORD ?? '';
}

function writeReport(path, report) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sanitizeResilienceReport(report), null, 2)}\n`, 'utf8');
}

async function configureSegmentedSurface(page, timeoutMs) {
  await setPower(page, true, timeoutMs);
  await selectPipeline(page, 'segmented', timeoutMs);
  await selectMode(page, 'auto', timeoutMs);
  await ensureRunnableDeckFixture(page, { mode: 'auto', families: [] }, timeoutMs);
  await page.evaluate(async () => {
    const runtime = globalThis.__recursionLiveHarnessRuntime;
    const settings = runtime?.view?.()?.settings || {};
    const excludedKey = 'post' + 'Process';
    await runtime?.updateSettings?.({
      mode: 'auto', pipelineMode: 'segmented', minCards: 2, maxCards: 2, reasoningLevel: 'medium',
      [excludedKey]: { ...(settings[excludedKey] || {}), enabled: false },
      injection: { ...(settings.injection || {}), placement: 'in_prompt', depth: 1, role: 'system' }
    });
  });
}

export async function runLiveSegmentedUtilityProfile({ argv = process.argv.slice(2), env = process.env } = {}) {
  const args = parseSegmentedProfileArgs(argv);
  const userVerdict = validateSoakUserHandle(String(env.RECURSION_SILLYTAVERN_USER || '').trim());
  if (!userVerdict.ok) throw new Error('Segmented profile proof requires a dedicated recursion-soak-* user.');
  const baseUrl = String(env.SILLYTAVERN_BASE_URL || '').trim();
  if (!baseUrl) throw new Error('SILLYTAVERN_BASE_URL is required.');
  const timeoutMs = Number(env.RECURSION_LIVE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const session = createSillyTavernHttpSession({
    baseUrl,
    user: userVerdict.user,
    password: passwordForUser(userVerdict.user, env)
  });
  await session.init();
  await session.login();
  const browser = await chromium.launch({ headless: env.RECURSION_SILLYTAVERN_HEADLESS !== '0' });
  let report = null;
  try {
    const context = await browser.newContext();
    try {
      await context.addInitScript(() => { globalThis.__recursionLiveHarness = true; });
      await context.addCookies(session.playwrightCookies());
      const page = await context.newPage();
      const requestAudit = { fusedBundleRequests: 0 };
      page.on('request', (request) => {
        if (!String(request.url?.() || '').includes('/api/backends/chat-completions/generate')) return;
        const body = String(request.postData?.() || '');
        if (body.includes('recursion.fusedCardBundle.v1') || body.includes('fusedCardBundle')) {
          requestAudit.fusedBundleRequests += 1;
        }
      });
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      await waitForRoot(page, timeoutMs);
      const selected = await selectUtilityProfileByLabel(page, args.profileLabel, timeoutMs);
      const certification = await certifyUtilityProfile(page, timeoutMs, { scope: 'segmented' });
      await ensureSyntheticChat(page, timeoutMs);
      const chat = await startFreshSyntheticChat(page, timeoutMs);
      await configureSegmentedSurface(page, timeoutMs);
      const before = await page.evaluate(contextChatSummaryScript());
      const runId = `cydonia-segmented-${Date.now().toString(36)}`;
      await sendAndWait(page, `Recursion Segmented Cydonia proof ${runId}: I hold the archive threshold and ask Mara for one concise answer.`, {
        requirePrompt: true,
        timeoutMs
      });
      const execution = await readExecutionSnapshot(page);
      const after = await page.evaluate(contextChatSummaryScript());
      const verdict = inspectSegmentedProfileProof({ certification, requestAudit, execution, before, after });
      report = {
        schema: 'recursion.liveSegmentedUtilityProfile.v1',
        status: verdict.ok ? 'pass' : 'fail',
        profile: { label: boundedText(selected.label, 180), model: boundedText(selected.model || certification.model, 180) },
        pipeline: 'segmented',
        fusedTested: false,
        certification: {
          status: boundedText(certification.status, 40),
          checks: certification.checks,
          capability: boundedText(certification.capability, 80)
        },
        requestAudit,
        chatIdHash: hashIdentity(chat.chatId),
        operation: {
          operationId: boundedText(execution?.operationId, 180),
          turnKeyHash: boundedText(execution?.turnKeyHash, 180),
          state: boundedText(execution?.state, 40),
          stageCount: Array.isArray(execution?.stages) ? execution.stages.length : 0
        },
        hostCounts: {
          userDelta: Number(after.userCount || 0) - Number(before.userCount || 0),
          assistantDelta: Number(after.assistantCount || 0) - Number(before.assistantCount || 0)
        },
        verdict,
        branchSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        completedAt: new Date().toISOString()
      };
      writeReport(args.statePath, report);
      if (!verdict.ok) throw Object.assign(new Error(`Segmented Cydonia proof failed: ${verdict.errors.join(', ')}`), { result: 'fail' });
      return sanitizeResilienceReport(report);
    } finally {
      await context.close().catch(() => {});
    }
  } catch (error) {
    const failure = report || {
      schema: 'recursion.liveSegmentedUtilityProfile.v1',
      status: 'fail',
      summary: boundedText(error?.message || error, 500)
    };
    writeReport(args.statePath, failure);
    throw error;
  } finally {
    await browser.close().catch(() => {});
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await runLiveSegmentedUtilityProfile(), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: error.result || 'fail', summary: boundedText(error?.message || error, 500) }, null, 2));
    process.exitCode = 1;
  }
}
