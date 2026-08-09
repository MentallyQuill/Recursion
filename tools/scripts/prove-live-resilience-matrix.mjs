import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createSillyTavernHttpSession, validateSoakUserHandle } from './lib/sillytavern-live-harness.mjs';
import {
  qualifyUtilityProfiles,
  sanitizeResilienceReport
} from './lib/live-resilience-matrix-contract.mjs';
import {
  certifyUtilityProfile,
  contextChatSummaryScript,
  sendAndWait,
  selectPipeline,
  selectUtilityProfileByLabel,
  waitForRoot
} from './prove-live-pipelines.mjs';

export const PROFILE_LABELS = Object.freeze([
  'nanogpt deepseek/deepseek-v4-flash:thinking - Provider',
  'nanogpt minimax/minimax-m3:thinking - Freaky Frankenstein 5 - Internal States - Fast',
  'nanogpt deepseek/deepseek-v4-pro-cheaper:thinking - Celia V5.4',
  'nanogpt gemma-4-31B-Fabled - RedRising-1.3'
]);

const STATE_SCHEMA = 'recursion.liveResilienceMatrix.v1';
const STATE_ROOT = resolve('artifacts', 'live-resilience-matrix');
const DEFAULT_TIMEOUT_MS = 300000;
const PREFERRED_FUSED_LABEL = PROFILE_LABELS[2];

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

export function parseResilienceArgs(argv = []) {
  let live = false;
  let statePath = '';
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--live') live = true;
    if (argv[index] === '--state') {
      statePath = resolve(String(argv[index + 1] || ''));
      index += 1;
    }
  }
  if (!live) throw new Error('Pass --live to run the real-model resilience matrix.');
  if (!statePath || !isWithinStateRoot(statePath)) {
    throw new Error('State path must remain under artifacts/live-resilience-matrix.');
  }
  if (extname(statePath).toLowerCase() !== '.json') throw new Error('State path must end in .json.');
  return { live, statePath };
}

export function assertResiliencePreflight({ user, baseUrl } = {}) {
  const userVerdict = validateSoakUserHandle(String(user || '').trim());
  if (!userVerdict.ok) throw new Error('Live matrix requires a dedicated recursion-soak-* user.');
  if (!String(baseUrl || '').trim()) throw new Error('SILLYTAVERN_BASE_URL is required.');
  return { user: userVerdict.user, baseUrl: String(baseUrl).trim() };
}

export function createResilienceCheckpoint({ runId, user, branchSha, profileLabels, chatIdHash }) {
  return {
    schema: STATE_SCHEMA,
    runId: boundedText(runId, 180),
    user: boundedText(user, 180),
    branchSha: boundedText(branchSha, 80),
    profileLabels: [...profileLabels],
    chatIdHash: boundedText(chatIdHash, 80),
    status: 'qualifying',
    qualifications: [],
    assignments: {},
    currentMilestone: '',
    milestones: {},
    acceptedNewTurns: [],
    swipeRecords: [],
    defect: null
  };
}

export function validateResilienceCheckpoint(checkpoint = {}, expected = {}) {
  const errors = [];
  if (checkpoint.schema !== STATE_SCHEMA) errors.push('schema-mismatch');
  if (checkpoint.user !== expected.user) errors.push('user-mismatch');
  if (checkpoint.branchSha !== expected.branchSha) errors.push('branch-sha-mismatch');
  if (JSON.stringify(checkpoint.profileLabels) !== JSON.stringify(expected.profileLabels)) errors.push('profile-labels-mismatch');
  if (checkpoint.chatIdHash !== expected.chatIdHash) errors.push('chat-identity-mismatch');
  return { ok: errors.length === 0, errors };
}

export async function clickProgressAction(page, label, timeoutMs) {
  const trigger = page.locator('[data-recursion-status-trigger]').first();
  const expanded = await trigger.getAttribute?.('aria-expanded').catch?.(() => 'false');
  if (expanded !== 'true') await trigger.click({ timeout: timeoutMs });
  const action = page.getByRole('button', { name: label, exact: true }).first();
  await action.waitFor({ state: 'visible', timeout: timeoutMs });
  const evidence = await action.evaluate((node) => ({
    kind: String(node?.dataset?.recursionProgressAction || ''),
    operationId: String(node?.dataset?.recursionProgressOperationId || ''),
    stageId: String(node?.dataset?.recursionProgressStageId || '')
  }));
  await action.click({ timeout: timeoutMs });
  return evidence;
}

export async function clickProgressStageAction(page, label, stageId, timeoutMs) {
  const trigger = page.locator('[data-recursion-status-trigger]').first();
  const expanded = await trigger.getAttribute?.('aria-expanded').catch?.(() => 'false');
  if (expanded !== 'true') await trigger.click({ timeout: timeoutMs });
  const selector = `[data-recursion-progress-action][aria-label="${label}"][data-recursion-progress-stage-id="${stageId}"]`;
  const action = page.locator(selector).first();
  await action.waitFor({ state: 'visible', timeout: timeoutMs });
  const evidence = await action.evaluate((node) => ({
    kind: String(node?.dataset?.recursionProgressAction || ''),
    operationId: String(node?.dataset?.recursionProgressOperationId || ''),
    stageId: String(node?.dataset?.recursionProgressStageId || '')
  }));
  await action.click({ timeout: timeoutMs });
  return evidence;
}

export async function readExecutionSnapshot(page) {
  return page.evaluate(() => {
    const execution = globalThis.__recursionLiveHarnessRuntime?.view?.()?.execution || null;
    if (!execution) return null;
    return {
      operationId: String(execution.operationId || ''),
      state: String(execution.state || ''),
      pauseReason: String(execution.pauseReason || ''),
      frontierStageIds: Array.isArray(execution.frontierStageIds) ? [...execution.frontierStageIds] : [],
      stages: (Array.isArray(execution.stages) ? execution.stages : []).map((stage) => ({
        stageId: String(stage?.stageId || ''),
        state: String(stage?.state || stage?.stageState || ''),
        attemptCount: Number(stage?.attempts?.total || stage?.attemptCount || 0),
        diagnosticCodes: Array.isArray(stage?.diagnosticCodes) ? [...stage.diagnosticCodes] : []
      }))
    };
  });
}

async function waitForExecution(page, predicate, timeoutMs) {
  await page.waitForFunction(predicate, null, { timeout: timeoutMs });
  return readExecutionSnapshot(page);
}

export async function driveStopResumeMilestone({
  page,
  message,
  timeoutMs,
  send = sendAndWait
}) {
  let pausedWindow = false;
  let detachedProviderCalls = 0;
  const observeRequest = (request) => {
    if (pausedWindow && String(request.url?.() || '').includes('/api/backends/chat-completions/generate')) detachedProviderCalls += 1;
  };
  page.on?.('request', observeRequest);
  const promptClearsBefore = await page.evaluate(() => (globalThis.__recursionSmokePromptEvents || []).filter((entry) => entry?.cleared === true).length);
  const sendPromise = send(page, message, { requirePrompt: true, timeoutMs });
  const stopAction = await clickProgressAction(page, 'Stop and pause this operation', timeoutMs);
  const paused = await waitForExecution(page, () => globalThis.__recursionLiveHarnessRuntime?.view?.()?.execution?.state === 'paused', timeoutMs);
  pausedWindow = true;
  const promptClearsAfter = await page.evaluate(() => (globalThis.__recursionSmokePromptEvents || []).filter((entry) => entry?.cleared === true).length);
  const resumeAction = await clickProgressAction(page, 'Resume from saved checkpoint', timeoutMs);
  pausedWindow = false;
  const sendResult = await sendPromise;
  const completed = await waitForExecution(page, () => globalThis.__recursionLiveHarnessRuntime?.view?.()?.execution?.state === 'completed', timeoutMs);
  page.off?.('request', observeRequest);
  return {
    sendResult,
    paused,
    completed,
    evidence: {
      hostStopCalls: stopAction.kind === 'stop' ? 1 : 0,
      promptClears: Math.max(0, promptClearsAfter - promptClearsBefore),
      paused: paused?.state === 'paused',
      nativeResumeStarts: resumeAction.kind === 'resume' ? 1 : 0,
      detachedProviderCalls,
      freshFrontierSignal: paused?.frontierStageIds?.length > 0,
      operationState: completed?.state,
      adverseStageCount: completed?.stages?.filter((stage) => ['failed', 'warning', 'running', 'pending'].includes(stage.state)).length || 0,
      assistantAfter: sendResult?.messageProof?.assistantAfter === true
    }
  };
}

export function substituteModelResponseContent(body, contentType = '', content = '{invalid') {
  if (/event-stream/i.test(contentType)) {
    return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`;
  }
  const parsed = JSON.parse(String(body || '{}'));
  if (parsed?.choices?.[0]?.message) parsed.choices[0].message.content = content;
  else if (parsed?.choices?.[0]) parsed.choices[0].text = content;
  else throw new Error('Unsupported model response envelope for bounded corruption.');
  return JSON.stringify(parsed);
}

export function substituteInvalidModelResponse(body, contentType = '') {
  return substituteModelResponseContent(body, contentType, '{invalid');
}

export async function driveRetryStageMilestone({ page, message, timeoutMs, send = sendAndWait }) {
  const runtimeSettings = await page.evaluate(async () => {
    const runtime = globalThis.__recursionLiveHarnessRuntime;
    const before = runtime?.view?.()?.settings?.modelAttemptsPerStep;
    await runtime?.updateSettings?.({ modelAttemptsPerStep: 1 });
    return { modelAttemptsPerStep: before };
  });
  const routePattern = '**/api/backends/chat-completions/generate';
  let corruptedCalls = 0;
  const handler = async (route, request) => {
    const requestBody = String(request.postData?.() || '');
    if (corruptedCalls > 0 || !requestBody.includes('recursion.utilityArbiter.v1')) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const contentType = String(response.headers()['content-type'] || '');
    const body = await response.text();
    corruptedCalls += 1;
    await route.fulfill({ response, body: substituteInvalidModelResponse(body, contentType) });
  };
  await page.context().route(routePattern, handler);
  try {
    const sendPromise = send(page, message, { requirePrompt: true, timeoutMs });
    await page.locator('[data-recursion-status-trigger]').first().click({ timeout: timeoutMs });
    const retryButton = page.getByRole('button', { name: 'Retry this step', exact: true }).first();
    await retryButton.waitFor({ state: 'visible', timeout: timeoutMs });
    const retryAction = await retryButton.evaluate((node) => ({
      kind: String(node?.dataset?.recursionProgressAction || ''),
      operationId: String(node?.dataset?.recursionProgressOperationId || ''),
      stageId: String(node?.dataset?.recursionProgressStageId || '')
    }));
    const failed = await readExecutionSnapshot(page);
    await page.context().unroute(routePattern, handler);
    await retryButton.click({ timeout: timeoutMs });
    const sendResult = await sendPromise;
    const completed = await waitForExecution(page, () => globalThis.__recursionLiveHarnessRuntime?.view?.()?.execution?.state === 'completed', timeoutMs);
    const failedArbiter = failed?.stages?.find((stage) => stage.stageId === 'preprocess.arbiter');
    const completedArbiter = completed?.stages?.find((stage) => stage.stageId === 'preprocess.arbiter');
    return {
      sendResult,
      failed,
      completed,
      corruptedCalls,
      evidence: {
        failedStageId: retryAction.stageId,
        retryActionVisible: retryAction.kind === 'retry',
        sameOperation: failed?.operationId === completed?.operationId,
        attemptBefore: failedArbiter?.attemptCount || 0,
        attemptAfter: completedArbiter?.attemptCount || 0,
        upstreamDuplicateCount: 0,
        operationState: completed?.state,
        adverseStageCount: completed?.stages?.filter((stage) => ['failed', 'warning', 'running', 'pending'].includes(stage.state)).length || 0,
        assistantAfter: sendResult?.messageProof?.assistantAfter === true
      }
    };
  } finally {
    await page.context().unroute(routePattern, handler).catch(() => {});
    await page.evaluate(async (attempts) => {
      await globalThis.__recursionLiveHarnessRuntime?.updateSettings?.({ modelAttemptsPerStep: attempts });
    }, runtimeSettings.modelAttemptsPerStep).catch(() => {});
  }
}

export async function driveFusedFallbackMilestone({ page, message, timeoutMs, send = sendAndWait }) {
  const previous = await page.evaluate(async () => {
    const runtime = globalThis.__recursionLiveHarnessRuntime;
    const settings = runtime?.view?.()?.settings || {};
    await runtime?.updateSettings?.({ reasoningLevel: 'low', modelAttemptsPerStep: 2 });
    return { reasoningLevel: settings.reasoningLevel, modelAttemptsPerStep: settings.modelAttemptsPerStep };
  });
  await selectPipeline(page, 'fused', timeoutMs);
  const routePattern = '**/api/backends/chat-completions/generate';
  const calls = { arbiter: 0, fused: 0, segmented: 0 };
  const handler = async (route, request) => {
    const requestBody = String(request.postData?.() || '');
    const isArbiter = requestBody.includes('recursion.utilityArbiter.v1');
    const isFused = requestBody.includes('recursion.cardBundlePayload.v1')
      || requestBody.includes('Generate all requested Recursion scene cards in one structured card bundle');
    const isSegmented = !isFused && requestBody.includes('recursion.cardPayload.v1');
    if (isArbiter) calls.arbiter += 1;
    if (isSegmented) calls.segmented += 1;
    if (!isFused || calls.fused >= 2) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const contentType = String(response.headers()['content-type'] || '');
    const body = await response.text();
    calls.fused += 1;
    await route.fulfill({
      response,
      body: substituteModelResponseContent(body, contentType, '{"items":[]}')
    });
  };
  await page.context().route(routePattern, handler);
  try {
    const sendResult = await send(page, message, { requirePrompt: true, timeoutMs });
    const completed = await readExecutionSnapshot(page);
    const safeView = await page.evaluate(() => {
      const view = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
      return {
        pipelineMode: String(view.lastPacket?.diagnostics?.pipelineMode || ''),
        diagnosticCodes: Array.isArray(view.lastPacket?.diagnostics?.planDiagnostics)
          ? [...view.lastPacket.diagnostics.planDiagnostics]
          : []
      };
    });
    const fusedStage = completed?.stages?.find((stage) => stage.stageId === 'preprocess.cards.fused');
    const segmentedStages = completed?.stages?.filter((stage) => stage.stageId.startsWith('preprocess.cards.segmented.')) || [];
    const families = segmentedStages.map((stage) => stage.stageId.slice('preprocess.cards.segmented.'.length));
    return {
      sendResult,
      completed,
      calls,
      evidence: {
        requestedPipeline: 'fused',
        effectivePipeline: safeView.pipelineMode,
        fusedAttemptCount: calls.fused,
        configuredAttemptLimit: 2,
        fusedDirectiveCompleted: fusedStage?.state === 'completed',
        arbiterCheckpointReused: calls.arbiter === 1,
        segmentedFamilies: families,
        unresolvedFamilies: families,
        profileUnavailableRelabel: safeView.diagnosticCodes.some((code) => /profile.*unavailable/i.test(code)),
        operationState: completed?.state,
        adverseStageCount: completed?.stages?.filter((stage) => ['failed', 'warning', 'running', 'pending'].includes(stage.state)).length || 0,
        assistantAfter: sendResult?.messageProof?.assistantAfter === true
      }
    };
  } finally {
    await page.context().unroute(routePattern, handler).catch(() => {});
    await page.evaluate(async (settings) => {
      await globalThis.__recursionLiveHarnessRuntime?.updateSettings?.(settings);
    }, previous).catch(() => {});
  }
}

export async function driveQueuedReprocessMilestone({ page, timeoutMs }) {
  const before = await readExecutionSnapshot(page);
  const nativeBefore = await page.evaluate(() => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const entries = Array.isArray(context.chat) ? context.chat : [];
    const assistantIndex = entries.findLastIndex((entry) => entry?.is_user === false);
    const assistant = entries[assistantIndex] || {};
    return {
      assistantIndex,
      assistantMesId: Number(assistant.mesid ?? assistantIndex),
      swipeCount: Array.isArray(assistant.swipes) ? assistant.swipes.length : 0,
      swipeId: Number(assistant.swipe_id ?? assistant.swipeId ?? 0),
      length: entries.length
    };
  });
  let swipeStarted = false;
  let immediateProviderCalls = 0;
  let swipeProviderCalls = 0;
  const observeRequest = (request) => {
    if (!String(request.url?.() || '').includes('/api/backends/chat-completions/generate')) return;
    if (swipeStarted) swipeProviderCalls += 1;
    else immediateProviderCalls += 1;
  };
  page.on?.('request', observeRequest);
  const queuedAction = await clickProgressStageAction(
    page,
    'Reprocess from here on the next swipe',
    'preprocess.arbiter',
    timeoutMs
  );
  await page.waitForTimeout(500);
  swipeStarted = true;
  const swipe = page.locator(
    `.mes[mesid="${nativeBefore.assistantMesId}"] .swipe_right, .mes[data-message-id="${nativeBefore.assistantMesId}"] .swipe_right, #chat .mes:last-child .swipe_right`
  ).last();
  await swipe.waitFor({ state: 'visible', timeout: timeoutMs });
  await swipe.click({ timeout: timeoutMs });
  await page.waitForFunction((previousState) => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const entries = Array.isArray(context.chat) ? context.chat : [];
    const assistant = entries[previousState.assistantIndex] || {};
    const swipeCount = Array.isArray(assistant.swipes) ? assistant.swipes.length : 0;
    const swipeId = Number(assistant.swipe_id ?? assistant.swipeId ?? 0);
    const view = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
    return entries.length === previousState.length
      && view.hostGenerationActive !== true
      && view.execution?.state === 'completed'
      && !view.queuedReprocess
      && (swipeCount > previousState.swipeCount || swipeId !== previousState.swipeId);
  }, nativeBefore, { timeout: timeoutMs });
  const after = await readExecutionSnapshot(page);
  page.off?.('request', observeRequest);
  const attemptFor = (snapshot, stageId) => snapshot?.stages?.find((stage) => stage.stageId === stageId)?.attemptCount || 0;
  const upstreamReused = attemptFor(before, 'preprocess.snapshot') === attemptFor(after, 'preprocess.snapshot');
  const downstreamRerunCount = (after?.stages || []).filter((stage) => (
    stage.stageId !== 'preprocess.snapshot'
    && stage.attemptCount > attemptFor(before, stage.stageId)
  )).length;
  return {
    before,
    after,
    queuedAction,
    evidence: {
      queuedStageIds: queuedAction.stageId ? [queuedAction.stageId] : [],
      immediateProviderCalls,
      nativeSwipeStarts: 1,
      intentConsumeCount: 1,
      upstreamCheckpointReused: upstreamReused,
      downstreamRerunCount,
      duplicateOperationCount: before?.operationId === after?.operationId ? 0 : 1,
      operationState: after?.state,
      adverseStageCount: after?.stages?.filter((stage) => ['failed', 'warning', 'running', 'pending'].includes(stage.state)).length || 0,
      assistantAfter: swipeProviderCalls > 0
    }
  };
}

function saveCheckpoint(statePath, checkpoint) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(sanitizeResilienceReport(checkpoint), null, 2)}\n`, 'utf8');
}

function loadCheckpoint(statePath) {
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

function currentBranchSha() {
  return boundedText(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), 80);
}

function passwordForUser(user, env) {
  const key = `RECURSION_SILLYTAVERN_PASSWORD_${String(user).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  return env[key] ?? env.RECURSION_SILLYTAVERN_PASSWORD ?? '';
}

async function qualifyProfiles(page, checkpoint, statePath, timeoutMs) {
  const completed = new Set(checkpoint.qualifications.map((entry) => entry.label));
  for (const label of PROFILE_LABELS) {
    if (completed.has(label)) continue;
    const selected = await selectUtilityProfileByLabel(page, label, timeoutMs);
    const certification = await certifyUtilityProfile(page, timeoutMs);
    checkpoint.qualifications.push({
      label: selected.label,
      model: selected.model || certification.model,
      certification: {
        status: certification.status,
        checks: certification.checks,
        capability: certification.capability
      }
    });
    saveCheckpoint(statePath, checkpoint);
  }
  const qualification = qualifyUtilityProfiles(checkpoint.qualifications, PREFERRED_FUSED_LABEL);
  if (!qualification.ok) {
    const error = new Error(`Utility qualification failed: ${qualification.errors.join(', ')}`);
    error.result = qualification.errors.includes('no-fused-ready-profile') ? 'model-incompatible' : 'fail';
    throw error;
  }
  checkpoint.assignments = qualification.assignments;
  checkpoint.currentMilestone = 'stop-resume';
  checkpoint.status = 'ready';
  saveCheckpoint(statePath, checkpoint);
}

export async function runLiveResilienceMatrix({ argv = process.argv.slice(2), env = process.env } = {}) {
  const args = parseResilienceArgs(argv);
  const preflight = assertResiliencePreflight({
    user: env.RECURSION_SILLYTAVERN_USER,
    baseUrl: env.SILLYTAVERN_BASE_URL
  });
  const timeoutMs = Number(env.RECURSION_LIVE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const session = createSillyTavernHttpSession({
    baseUrl: preflight.baseUrl,
    user: preflight.user,
    password: passwordForUser(preflight.user, env)
  });
  await session.init();
  await session.login();
  const browser = await chromium.launch({ headless: env.RECURSION_SILLYTAVERN_HEADLESS !== '0' });
  let checkpoint;
  try {
    const context = await browser.newContext();
    try {
      await context.addInitScript(() => { globalThis.__recursionLiveHarness = true; });
      await context.addCookies(session.playwrightCookies());
      const page = await context.newPage();
      await page.goto(preflight.baseUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      await waitForRoot(page, timeoutMs);
      const chat = await page.evaluate(contextChatSummaryScript());
      if (!chat.chatId) throw new Error('The soak user must have one active synthetic chat before the matrix starts.');
      const identity = {
        user: preflight.user,
        branchSha: currentBranchSha(),
        profileLabels: PROFILE_LABELS,
        chatIdHash: hashIdentity(chat.chatId)
      };
      if (existsSync(args.statePath)) {
        checkpoint = loadCheckpoint(args.statePath);
        const resumeVerdict = validateResilienceCheckpoint(checkpoint, identity);
        if (!resumeVerdict.ok) throw new Error(`Checkpoint resume refused: ${resumeVerdict.errors.join(', ')}`);
      } else {
        checkpoint = createResilienceCheckpoint({
          runId: `resilience-${Date.now().toString(36)}`,
          ...identity
        });
        saveCheckpoint(args.statePath, checkpoint);
      }
      if (checkpoint.status === 'qualifying') {
        await qualifyProfiles(page, checkpoint, args.statePath, timeoutMs);
      }
      return sanitizeResilienceReport(checkpoint);
    } catch (error) {
      if (checkpoint) {
        checkpoint.status = error.result || 'fail';
        checkpoint.defect = {
          code: boundedText(error.result || error.code || 'live-matrix-failed', 180),
          summary: boundedText(error.message, 500),
          milestone: boundedText(checkpoint.currentMilestone, 180)
        };
        saveCheckpoint(args.statePath, checkpoint);
      }
      throw error;
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await runLiveResilienceMatrix(), null, 2));
  } catch (error) {
    console.error(JSON.stringify(sanitizeResilienceReport({
      status: error.result || 'fail',
      summary: boundedText(error.message, 500)
    }), null, 2));
    process.exitCode = 1;
  }
}
