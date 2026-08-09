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
