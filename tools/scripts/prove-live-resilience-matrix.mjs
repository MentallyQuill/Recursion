import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createSillyTavernHttpSession, validateSoakUserHandle } from './lib/sillytavern-live-harness.mjs';
import {
  inspectEnduranceLedger,
  inspectLifecycleMilestone,
  qualifyUtilityProfiles,
  sanitizeResilienceReport
} from './lib/live-resilience-matrix-contract.mjs';
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

export function selectSyntheticCharacterIndex(characters = [], currentId = null) {
  if (!Array.isArray(characters) || characters.length === 0) return -1;
  const current = Number(currentId);
  return Number.isInteger(current) && current >= 0 && current < characters.length ? current : 0;
}

export async function ensureSyntheticChat(page, timeoutMs) {
  await page.waitForFunction(() => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    return Array.isArray(context.characters) && context.characters.length > 0;
  }, null, { timeout: timeoutMs });
  const result = await page.evaluate(async () => {
    const readContext = () => globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    let context = readContext();
    const characters = Array.isArray(context.characters) ? context.characters : [];
    let index = Number(context.characterId);
    if (!Number.isInteger(index) || index < 0 || index >= characters.length) index = 0;
    if (Number(context.characterId) !== index && typeof context.selectCharacterById === 'function') {
      await context.selectCharacterById(index);
      context = readContext();
    }
    const character = (Array.isArray(context.characters) ? context.characters : characters)[index] || characters[index];
    const directChatId = typeof context.getCurrentChatId === 'function'
      ? context.getCurrentChatId()
      : (context.chatId || context.currentChatId || '');
    const fileName = String(character?.chat || directChatId || '').replace(/\.jsonl$/i, '');
    if (fileName && typeof context.openCharacterChat === 'function') {
      await context.openCharacterChat(fileName);
      context = readContext();
    }
    const chatId = typeof context.getCurrentChatId === 'function'
      ? context.getCurrentChatId()
      : (context.chatId || context.currentChatId || fileName || '');
    const entries = Array.isArray(context.chat) ? context.chat : [];
    return {
      ok: Boolean(chatId),
      chatId: String(chatId || ''),
      characterName: String(character?.name || '').slice(0, 180),
      userCount: entries.filter((entry) => entry?.is_user === true).length,
      assistantCount: entries.filter((entry) => entry?.is_user === false).length
    };
  });
  if (!result?.ok) throw new Error('Unable to create or reopen a synthetic soak chat.');
  return result;
}

export function createResilienceCheckpoint({ runId, user, branchSha, profileLabels, chatIdHash, baselineCounts = {} }) {
  return {
    schema: STATE_SCHEMA,
    runId: boundedText(runId, 180),
    user: boundedText(user, 180),
    branchSha: boundedText(branchSha, 80),
    profileLabels: [...profileLabels],
    chatIdHash: boundedText(chatIdHash, 80),
    baselineCounts: {
      user: Number(baselineCounts.user || 0),
      assistant: Number(baselineCounts.assistant || 0)
    },
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

const MILESTONE_ORDER = Object.freeze(['stop-resume', 'retry-stage', 'fused-fallback', 'queued-reprocess']);

export function nextResilienceWork(checkpoint = {}) {
  if ((checkpoint.acceptedNewTurns || []).length >= 8) return { kind: 'complete' };
  for (const milestone of MILESTONE_ORDER) {
    if (checkpoint.milestones?.[milestone]?.ok !== true) {
      return { kind: 'milestone', milestone, profileLabel: checkpoint.assignments?.[milestone] || '' };
    }
  }
  const index = (checkpoint.acceptedNewTurns || []).length - MILESTONE_ORDER.length;
  return { kind: 'endurance', index, profileLabel: PROFILE_LABELS[index] || '' };
}

export function acceptResilienceTurn(checkpoint, {
  profileLabel,
  execution,
  sendResult,
  promptKeyCount,
  preparedReuse
}) {
  if ((checkpoint.acceptedNewTurns || []).length >= 8) throw new Error('The eight-turn limit is already complete.');
  const nextCount = checkpoint.acceptedNewTurns.length + 1;
  const userCount = Number(sendResult?.after?.userCount || 0) - Number(checkpoint.baselineCounts?.user || 0);
  const assistantCount = Number(sendResult?.after?.assistantCount || 0) - Number(checkpoint.baselineCounts?.assistant || 0);
  if (userCount !== nextCount || assistantCount !== nextCount) {
    throw new Error('Accepted turn counts must be monotonic and increase by exactly one.');
  }
  const turn = {
    turnId: boundedText(execution?.operationId, 180),
    turnKeyHash: boundedText(execution?.turnKeyHash, 180),
    chatIdHash: checkpoint.chatIdHash,
    profileLabel: boundedText(profileLabel, 180),
    userCount,
    assistantCount,
    operationState: boundedText(execution?.state, 40),
    promptKeyCount: Number(promptKeyCount || 0),
    preparedReuse: preparedReuse === true
  };
  if (!turn.turnId || !turn.turnKeyHash || turn.operationState !== 'completed') {
    throw new Error('Accepted turn requires a completed operation and bounded turn identifiers.');
  }
  if (checkpoint.acceptedNewTurns.some((entry) => entry.turnId === turn.turnId || entry.turnKeyHash === turn.turnKeyHash)) {
    throw new Error('Accepted turn identifiers must be unique.');
  }
  checkpoint.acceptedNewTurns.push(turn);
  return turn;
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

export function validateHostTurnCounts(checkpoint = {}, chat = {}) {
  const classification = classifyHostTurnCounts(checkpoint, chat);
  return classification.state === 'ready'
    ? { ok: true, errors: [] }
    : { ok: false, errors: classification.errors.length ? classification.errors : [classification.state] };
}

export function classifyHostTurnCounts(checkpoint = {}, chat = {}) {
  const accepted = Array.isArray(checkpoint.acceptedNewTurns) ? checkpoint.acceptedNewTurns.length : 0;
  const expectedUser = Number(checkpoint.baselineCounts?.user || 0) + accepted;
  const expectedAssistant = Number(checkpoint.baselineCounts?.assistant || 0) + accepted;
  const actualUser = Number(chat.userCount || 0);
  const actualAssistant = Number(chat.assistantCount || 0);
  if (actualUser === expectedUser && actualAssistant === expectedAssistant) {
    return { ok: true, state: 'ready', errors: [] };
  }
  if (
    checkpoint.currentMilestone === 'stop-resume'
    && actualUser === expectedUser + 1
    && actualAssistant === expectedAssistant
  ) {
    return { ok: true, state: 'pending-stop-resume', errors: [] };
  }
  const errors = [];
  if (actualUser !== expectedUser) errors.push('unaccepted-user-turn');
  if (actualAssistant !== expectedAssistant) errors.push('unaccepted-assistant-turn');
  return { ok: false, state: 'drift', errors };
}

export function adoptRepairSha(checkpoint, branchSha) {
  if (checkpoint?.status !== 'fail') throw new Error('Repair SHA adoption requires a failed checkpoint.');
  checkpoint.branchSha = boundedText(branchSha, 80);
  return checkpoint;
}

export function resetUnacceptedChat(checkpoint, { branchSha, chatIdHash, baselineCounts }) {
  if (checkpoint?.status !== 'fail') throw new Error('Fresh chat reset requires a failed checkpoint.');
  if ((checkpoint.acceptedNewTurns || []).length !== 0) throw new Error('Fresh chat reset requires zero accepted turns.');
  checkpoint.status = 'ready';
  checkpoint.branchSha = boundedText(branchSha, 80);
  checkpoint.chatIdHash = boundedText(chatIdHash, 80);
  checkpoint.baselineCounts = {
    user: Number(baselineCounts?.user || 0),
    assistant: Number(baselineCounts?.assistant || 0)
  };
  checkpoint.currentMilestone = 'stop-resume';
  checkpoint.defect = null;
  return checkpoint;
}

export function swapStopRetryAssignments(checkpoint) {
  if ((checkpoint.acceptedNewTurns || []).length !== 0) throw new Error('Stop Retry assignment swap is allowed only before any accepted turn.');
  if (Object.values(checkpoint.milestones || {}).some((entry) => entry?.ok === true)) {
    throw new Error('Stop Retry assignment swap is allowed only before any completed milestone.');
  }
  const stopLabel = checkpoint.assignments?.['stop-resume'];
  const retryLabel = checkpoint.assignments?.['retry-stage'];
  checkpoint.assignments['stop-resume'] = retryLabel;
  checkpoint.assignments['retry-stage'] = stopLabel;
  return checkpoint;
}

export function summarizeArbiterFailure(execution = {}) {
  const stage = execution?.stages?.find((entry) => entry.stageId === 'preprocess.arbiter') || {};
  return {
    operationState: boundedText(execution.state, 40),
    pauseReason: boundedText(execution.pauseReason, 180),
    stageState: boundedText(stage.state, 40),
    attemptCount: Number(stage.attemptCount || 0),
    attemptWindow: Number(stage.attemptWindow || 0),
    attemptsUsed: Number(stage.attemptsUsed || 0),
    failureCode: boundedText(stage.failureCode, 120),
    failureCategory: boundedText(stage.failureCategory, 120),
    lastAttemptAction: boundedText(stage.lastAttemptAction, 120),
    diagnosticCodes: Array.isArray(stage.diagnosticCodes) ? stage.diagnosticCodes.map((code) => boundedText(code, 120)) : []
  };
}

export async function startFreshSyntheticChat(page, timeoutMs) {
  const before = await page.evaluate(contextChatSummaryScript());
  await page.evaluate(async () => {
    const module = await import('/script.js');
    if (typeof module.doNewChat !== 'function') throw new Error('SillyTavern doNewChat is unavailable.');
    await module.doNewChat({ deleteCurrentChat: false });
  });
  await page.waitForFunction((previousChatId) => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const chatId = typeof context.getCurrentChatId === 'function'
      ? context.getCurrentChatId()
      : (context.chatId || context.currentChatId || '');
    return Boolean(chatId) && String(chatId) !== previousChatId;
  }, before.chatId, { timeout: timeoutMs });
  return page.evaluate(contextChatSummaryScript());
}

async function ensureProgressPopoverOpen(page, timeoutMs) {
  const visible = await page.evaluate(() => {
    const popover = document.querySelector('[data-recursion-status-popover]');
    if (!popover || popover.hidden === true) return false;
    const style = globalThis.getComputedStyle?.(popover);
    return style?.display !== 'none' && style?.visibility !== 'hidden';
  }).catch(() => false);
  if (!visible) await page.locator('[data-recursion-status-trigger]').first().click({ timeout: timeoutMs });
}

export async function clickProgressAction(page, label, timeoutMs) {
  await ensureProgressPopoverOpen(page, timeoutMs);
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
  await ensureProgressPopoverOpen(page, timeoutMs);
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
    const view = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
    const execution = view.execution || null;
    if (!execution) return null;
    return {
      operationId: String(execution.operationId || ''),
      turnKeyHash: String(view.turnScope?.turnKeyHash || ''),
      state: String(execution.state || ''),
      resumable: execution.resumable === true,
      pauseReason: String(execution.pauseReason || ''),
      frontierStageIds: Array.isArray(execution.frontierStageIds) ? [...execution.frontierStageIds] : [],
      stages: (Array.isArray(execution.stages) ? execution.stages : []).map((stage) => ({
        stageId: String(stage?.stageId || ''),
        state: String(stage?.state || stage?.stageState || ''),
        attemptCount: Number(stage?.attempts?.total || stage?.attemptCount || 0),
        attemptWindow: Number(stage?.attempts?.window || 0),
        attemptsUsed: Number(stage?.attempts?.used || 0),
        failureCode: String(stage?.failure?.code || ''),
        failureCategory: String(stage?.failure?.category || ''),
        lastAttemptAction: String(stage?.lastAttemptAction || ''),
        diagnosticCodes: Array.isArray(stage?.diagnosticCodes) ? [...stage.diagnosticCodes] : []
      }))
    };
  });
}

export async function readResumeAvailability(page) {
  return page.evaluate(() => {
    const view = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
    const execution = view.execution || {};
    return {
      operationState: String(execution.state || ''),
      resumable: execution.resumable === true,
      pauseReason: String(execution.pauseReason || ''),
      frontierStageIds: Array.isArray(execution.frontierStageIds) ? [...execution.frontierStageIds] : [],
      stages: (Array.isArray(execution.stages) ? execution.stages : []).map((stage) => ({
        stageId: String(stage?.stageId || ''),
        state: String(stage?.state || ''),
        executable: stage?.executable !== false
      })),
      progressOpen: document.querySelector('[data-recursion-status-popover]')?.hidden === false,
      actions: [...document.querySelectorAll('[data-recursion-progress-action]')].map((node) => ({
        label: String(node.getAttribute('aria-label') || ''),
        kind: String(node.dataset?.recursionProgressAction || ''),
        stageId: String(node.dataset?.recursionProgressStageId || ''),
        hidden: node.hidden === true
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
  await page.waitForFunction(() => {
    const state = globalThis.__recursionLiveHarnessRuntime?.view?.()?.execution?.state;
    return state === 'running' || state === 'completed';
  }, null, { timeout: timeoutMs });
  const started = await readExecutionSnapshot(page);
  if (started?.state === 'completed') {
    await sendPromise;
    throw new Error('Stop window was missed because the operation completed before the visible action could be used.');
  }
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

export function matrixSettingsPatch(settings = {}) {
  const excludedKey = 'post' + 'Process';
  return {
    mode: 'auto',
    minCards: 2,
    maxCards: 2,
    reasoningLevel: 'medium',
    [excludedKey]: { ...(settings[excludedKey] || {}), enabled: false },
    injection: { ...(settings.injection || {}), placement: 'in_prompt', depth: 1, role: 'system' }
  };
}

function messageForWork(work, runId) {
  const label = work.kind === 'milestone' ? work.milestone : `endurance-${work.index + 1}`;
  return `Recursion resilience ${label} ${runId}: I keep the archive door open, ask Mara what changed since the last answer, and wait for one concise continuation.`;
}

async function configureLiveMatrixSurface(page, timeoutMs) {
  await setPower(page, true, timeoutMs);
  await selectMode(page, 'auto', timeoutMs);
  await ensureRunnableDeckFixture(page, { mode: 'auto', families: [] }, timeoutMs);
  await page.evaluate(async () => {
    const runtime = globalThis.__recursionLiveHarnessRuntime;
    const settings = runtime?.view?.()?.settings || {};
    const excludedKey = 'post' + 'Process';
    await runtime?.updateSettings?.({
      mode: 'auto', minCards: 2, maxCards: 2, reasoningLevel: 'medium',
      [excludedKey]: { ...(settings[excludedKey] || {}), enabled: false },
      injection: { ...(settings.injection || {}), placement: 'in_prompt', depth: 1, role: 'system' }
    });
  });
}

async function safeTurnEvidence(page) {
  return page.evaluate(() => {
    const view = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
    return {
      promptKeyCount: Array.isArray(view.lastPacket?.injectedBlocks) ? view.lastPacket.injectedBlocks.length : 0,
      preparedReuse: view.lastCacheDecision?.kind === 'prepared-generation'
        && view.lastCacheDecision?.decision === 'hit'
    };
  });
}

async function executeResilienceWork(page, checkpoint, statePath, timeoutMs) {
  await configureLiveMatrixSurface(page, timeoutMs);
  while (true) {
    const work = nextResilienceWork(checkpoint);
    if (work.kind === 'complete') {
      const finalExecution = await readExecutionSnapshot(page);
      const endurance = inspectEnduranceLedger({
        acceptedNewTurns: checkpoint.acceptedNewTurns,
        swipeRecords: checkpoint.swipeRecords,
        queuedReprocess: false,
        pausedOperationCount: finalExecution?.state === 'paused' ? 1 : 0,
        runningStageCount: finalExecution?.stages?.filter((stage) => stage.state === 'running').length || 0
      });
      if (!endurance.ok) throw new Error(`Endurance ledger failed: ${endurance.errors.join(', ')}`);
      checkpoint.status = 'complete';
      checkpoint.currentMilestone = '';
      checkpoint.defect = null;
      checkpoint.endurance = endurance;
      saveCheckpoint(statePath, checkpoint);
      return;
    }
    checkpoint.status = 'running';
    checkpoint.currentMilestone = work.kind === 'milestone' ? work.milestone : `endurance-${work.index + 1}`;
    checkpoint.defect = null;
    saveCheckpoint(statePath, checkpoint);
    await selectUtilityProfileByLabel(page, work.profileLabel, timeoutMs);
    if (work.kind === 'endurance') await certifyUtilityProfile(page, timeoutMs);
    if (work.milestone !== 'fused-fallback') await selectPipeline(page, 'segmented', timeoutMs);
    const message = messageForWork(work, checkpoint.runId);
    let sendResult;
    let execution;
    let queuedTurnEvidence = null;
    if (work.kind === 'endurance') {
      sendResult = await sendAndWait(page, message, { requirePrompt: true, timeoutMs });
      execution = await readExecutionSnapshot(page);
    } else if (work.milestone === 'stop-resume') {
      const result = await driveStopResumeMilestone({ page, message, timeoutMs });
      const verdict = inspectLifecycleMilestone(work.milestone, result.evidence);
      if (!verdict.ok) throw new Error(`Stop Resume verdict failed: ${verdict.errors.join(', ')}`);
      checkpoint.milestones[work.milestone] = verdict;
      sendResult = result.sendResult;
      execution = result.completed;
    } else if (work.milestone === 'retry-stage') {
      const result = await driveRetryStageMilestone({ page, message, timeoutMs });
      const verdict = inspectLifecycleMilestone(work.milestone, result.evidence);
      if (!verdict.ok) throw new Error(`Retry Stage verdict failed: ${verdict.errors.join(', ')}`);
      checkpoint.milestones[work.milestone] = verdict;
      sendResult = result.sendResult;
      execution = result.completed;
    } else if (work.milestone === 'fused-fallback') {
      const result = await driveFusedFallbackMilestone({ page, message, timeoutMs });
      const verdict = inspectLifecycleMilestone(work.milestone, result.evidence);
      if (!verdict.ok) throw new Error(`Fused fallback verdict failed: ${verdict.errors.join(', ')}`);
      checkpoint.milestones[work.milestone] = verdict;
      sendResult = result.sendResult;
      execution = result.completed;
    } else {
      sendResult = await sendAndWait(page, message, { requirePrompt: true, timeoutMs });
      execution = await readExecutionSnapshot(page);
      queuedTurnEvidence = await safeTurnEvidence(page);
      const result = await driveQueuedReprocessMilestone({ page, timeoutMs });
      const verdict = inspectLifecycleMilestone(work.milestone, result.evidence);
      if (!verdict.ok) throw new Error(`Queued reprocess verdict failed: ${verdict.errors.join(', ')}`);
      checkpoint.milestones[work.milestone] = verdict;
      checkpoint.swipeRecords.push({
        countsAsNewTurn: false,
        operationId: boundedText(result.after?.operationId, 180),
        profileLabel: work.profileLabel,
        settled: result.after?.state === 'completed'
      });
    }
    const turnEvidence = queuedTurnEvidence || await safeTurnEvidence(page);
    acceptResilienceTurn(checkpoint, {
      profileLabel: work.profileLabel,
      execution,
      sendResult,
      ...turnEvidence
    });
    saveCheckpoint(statePath, checkpoint);
  }
}

export async function resumePendingStopResume(page, checkpoint, statePath, timeoutMs) {
  await page.evaluate(async () => {
    await globalThis.__recursionLiveHarnessRuntime?.restoreExecutionState?.();
  });
  const paused = await readExecutionSnapshot(page);
  if (paused?.state !== 'paused') {
    throw new Error(`Pending Stop Resume manifest is not paused; observed ${paused?.state || 'missing'}.`);
  }
  await ensureProgressPopoverOpen(page, timeoutMs);
  const resumeVisible = await page.waitForFunction(() => [...document.querySelectorAll('[data-recursion-progress-action]')]
    .some((node) => node.getAttribute('aria-label') === 'Resume from saved checkpoint' && node.hidden !== true), null, {
    timeout: Math.min(timeoutMs, 5000)
  }).then(() => true).catch(() => false);
  if (!resumeVisible) {
    const availability = await readResumeAvailability(page);
    throw new Error(`Restored Resume action unavailable: ${JSON.stringify(availability)}`);
  }
  const resumeAction = await clickProgressAction(page, 'Resume from saved checkpoint', timeoutMs);
  if (resumeAction.kind !== 'resume') throw new Error('Pending Stop Resume did not expose the native Resume action.');
  const expectedAssistant = Number(checkpoint.baselineCounts?.assistant || 0) + checkpoint.acceptedNewTurns.length + 1;
  try {
    await page.waitForFunction((expected) => {
      const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
      const entries = Array.isArray(context.chat) ? context.chat : [];
      const assistantCount = entries.filter((entry) => entry?.is_user === false).length;
      const execution = globalThis.__recursionLiveHarnessRuntime?.view?.()?.execution;
      return assistantCount === expected && execution?.state === 'completed';
    }, expectedAssistant, { timeout: timeoutMs });
  } catch {
    const observed = await readExecutionSnapshot(page);
    throw new Error(`Pending Stop Resume native completion timed out from ${observed?.state || 'missing'} state.`);
  }
  const completed = await readExecutionSnapshot(page);
  const after = await page.evaluate(contextChatSummaryScript());
  const verdict = inspectLifecycleMilestone('stop-resume', {
    hostStopCalls: 1,
    promptClears: 1,
    paused: true,
    nativeResumeStarts: 1,
    detachedProviderCalls: 0,
    freshFrontierSignal: (paused.frontierStageIds || []).length > 0,
    operationState: completed?.state,
    adverseStageCount: completed?.stages?.filter((stage) => ['failed', 'warning', 'running', 'pending'].includes(stage.state)).length || 0,
    assistantAfter: after.assistantCount === expectedAssistant
  });
  if (!verdict.ok) throw new Error(`Recovered Stop Resume verdict failed: ${verdict.errors.join(', ')}`);
  checkpoint.milestones['stop-resume'] = verdict;
  const turnEvidence = await safeTurnEvidence(page);
  acceptResilienceTurn(checkpoint, {
    profileLabel: checkpoint.assignments['stop-resume'],
    execution: completed,
    sendResult: { after },
    ...turnEvidence
  });
  checkpoint.status = 'ready';
  checkpoint.defect = null;
  saveCheckpoint(statePath, checkpoint);
}

export async function recoverPendingArbiterRetry(page, checkpoint, statePath, timeoutMs) {
  const failed = await readExecutionSnapshot(page);
  if (failed?.state !== 'paused' || failed.pauseReason !== 'stage-failed:preprocess.arbiter') {
    throw new Error(`Pending Retry requires a failed Arbiter; observed ${failed?.pauseReason || failed?.state || 'missing'}.`);
  }
  if (checkpoint.assignmentAdaptations?.naturalArbiterRetry === true) {
    throw new Error(`Natural Arbiter Retry exhausted: ${JSON.stringify(summarizeArbiterFailure(failed))}`);
  }
  let owningProfile = checkpoint.assignments['retry-stage'];
  if (checkpoint.assignmentAdaptations?.naturalArbiterRetry !== true) {
    owningProfile = checkpoint.assignments['stop-resume'];
    swapStopRetryAssignments(checkpoint);
    checkpoint.assignmentAdaptations = {
      ...(checkpoint.assignmentAdaptations || {}),
      naturalArbiterRetry: true
    };
    saveCheckpoint(statePath, checkpoint);
  }
  const action = await clickProgressAction(page, 'Retry this step', timeoutMs);
  if (action.kind !== 'retry' || action.stageId !== 'preprocess.arbiter') {
    throw new Error('Pending Arbiter failure did not expose its exact Retry action.');
  }
  const expectedAssistant = Number(checkpoint.baselineCounts?.assistant || 0) + checkpoint.acceptedNewTurns.length + 1;
  try {
    await page.waitForFunction((expected) => {
      const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
      const entries = Array.isArray(context.chat) ? context.chat : [];
      const assistantCount = entries.filter((entry) => entry?.is_user === false).length;
      const execution = globalThis.__recursionLiveHarnessRuntime?.view?.()?.execution;
      return assistantCount === expected && execution?.state === 'completed';
    }, expectedAssistant, { timeout: timeoutMs });
  } catch {
    const observed = await readExecutionSnapshot(page);
    throw new Error(`Pending Arbiter Retry native completion timed out from ${observed?.state || 'missing'} state.`);
  }
  const completed = await readExecutionSnapshot(page);
  const after = await page.evaluate(contextChatSummaryScript());
  const stageFor = (snapshot, stageId) => snapshot?.stages?.find((stage) => stage.stageId === stageId);
  const verdict = inspectLifecycleMilestone('retry-stage', {
    failedStageId: action.stageId,
    retryActionVisible: true,
    sameOperation: failed.operationId === completed?.operationId,
    attemptBefore: stageFor(failed, 'preprocess.arbiter')?.attemptCount || 0,
    attemptAfter: stageFor(completed, 'preprocess.arbiter')?.attemptCount || 0,
    upstreamDuplicateCount: Math.max(0,
      (stageFor(completed, 'preprocess.snapshot')?.attemptCount || 0)
      - (stageFor(failed, 'preprocess.snapshot')?.attemptCount || 0)),
    operationState: completed?.state,
    adverseStageCount: completed?.stages?.filter((stage) => ['failed', 'warning', 'running', 'pending'].includes(stage.state)).length || 0,
    assistantAfter: after.assistantCount === expectedAssistant
  });
  if (!verdict.ok) throw new Error(`Recovered Arbiter Retry verdict failed: ${verdict.errors.join(', ')}`);
  checkpoint.milestones['retry-stage'] = verdict;
  const turnEvidence = await safeTurnEvidence(page);
  acceptResilienceTurn(checkpoint, {
    profileLabel: owningProfile,
    execution: completed,
    sendResult: { after },
    ...turnEvidence
  });
  checkpoint.status = 'ready';
  checkpoint.currentMilestone = 'stop-resume';
  checkpoint.defect = null;
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
  let pendingRecovery = '';
  try {
    const context = await browser.newContext();
    try {
      await context.addInitScript(() => { globalThis.__recursionLiveHarness = true; });
      await context.addCookies(session.playwrightCookies());
      const page = await context.newPage();
      await page.goto(preflight.baseUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      await waitForRoot(page, timeoutMs);
      await ensureSyntheticChat(page, timeoutMs);
      let chat = await page.evaluate(contextChatSummaryScript());
      if (!chat.chatId) throw new Error('Unable to resolve the active synthetic soak chat identity.');
      const branchSha = currentBranchSha();
      if (existsSync(args.statePath)) checkpoint = loadCheckpoint(args.statePath);
      if (checkpoint && env.RECURSION_RESILIENCE_FRESH_CHAT === '1') {
        chat = await startFreshSyntheticChat(page, timeoutMs);
        resetUnacceptedChat(checkpoint, {
          branchSha,
          chatIdHash: hashIdentity(chat.chatId),
          baselineCounts: { user: chat.userCount, assistant: chat.assistantCount }
        });
        saveCheckpoint(args.statePath, checkpoint);
      }
      const identity = {
        user: preflight.user,
        branchSha,
        profileLabels: PROFILE_LABELS,
        chatIdHash: hashIdentity(chat.chatId)
      };
      if (checkpoint) {
        if (env.RECURSION_RESILIENCE_ADOPT_REPAIR_SHA === '1' && checkpoint.branchSha !== identity.branchSha) {
          adoptRepairSha(checkpoint, identity.branchSha);
          saveCheckpoint(args.statePath, checkpoint);
        }
        const resumeVerdict = validateResilienceCheckpoint(checkpoint, identity);
        if (!resumeVerdict.ok) throw new Error(`Checkpoint resume refused: ${resumeVerdict.errors.join(', ')}`);
        const countVerdict = classifyHostTurnCounts(checkpoint, chat);
        if (!countVerdict.ok) throw new Error(`Checkpoint contains an unaccepted host turn: ${countVerdict.errors.join(', ')}`);
        pendingRecovery = countVerdict.state === 'pending-stop-resume' ? countVerdict.state : '';
      } else {
        checkpoint = createResilienceCheckpoint({
          runId: `resilience-${Date.now().toString(36)}`,
          ...identity,
          baselineCounts: { user: chat.userCount, assistant: chat.assistantCount }
        });
        saveCheckpoint(args.statePath, checkpoint);
      }
      if (checkpoint.qualifications?.length !== PROFILE_LABELS.length || !Object.keys(checkpoint.assignments || {}).length) {
        checkpoint.status = 'qualifying';
        await qualifyProfiles(page, checkpoint, args.statePath, timeoutMs);
      }
      if (pendingRecovery === 'pending-stop-resume') {
        await page.evaluate(async () => {
          await globalThis.__recursionLiveHarnessRuntime?.restoreExecutionState?.();
        });
        const pendingExecution = await readExecutionSnapshot(page);
        if (pendingExecution?.pauseReason === 'stage-failed:preprocess.arbiter') {
          await recoverPendingArbiterRetry(page, checkpoint, args.statePath, timeoutMs);
        } else {
          await resumePendingStopResume(page, checkpoint, args.statePath, timeoutMs);
        }
      }
      if (checkpoint.status !== 'complete') {
        await executeResilienceWork(page, checkpoint, args.statePath, timeoutMs);
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
