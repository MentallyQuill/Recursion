import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { createSillyTavernHttpSession, validateSoakUserHandle } from './lib/sillytavern-live-harness.mjs';
import {
  collectLiveEnhancementRunOracle,
  installLiveEnhancementRunOracle
} from './lib/live-enhancement-run-oracle.mjs';

const baseUrl = process.env.SILLYTAVERN_BASE_URL || '';
const userCheck = validateSoakUserHandle(process.env.RECURSION_SILLYTAVERN_USER || '');
if (!userCheck.ok) throw new Error(`Unsafe SillyTavern live-test user: ${userCheck.reason}`);
const user = userCheck.user;
const passwordEnvKey = `RECURSION_SILLYTAVERN_PASSWORD_${user.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
const password = process.env[passwordEnvKey] ?? process.env.RECURSION_SILLYTAVERN_PASSWORD ?? '';
const timeoutMs = Number(process.env.RECURSION_LIVE_TIMEOUT_MS || 240000);
const artifactDir = resolve(process.env.RECURSION_ARTIFACT_DIR || 'artifacts/live-smoke/card-progress/latest');
mkdirSync(artifactDir, { recursive: true });

const session = createSillyTavernHttpSession({ baseUrl, user, password });
await session.init();
await session.login();

const browser = await chromium.launch({ headless: process.env.RECURSION_SILLYTAVERN_HEADLESS !== '0' });
try {
  const context = await browser.newContext({ viewport: { width: 1360, height: 820 } });
  await context.addCookies(session.playwrightCookies());
  await context.addInitScript(() => {
    globalThis.__recursionLiveHarness = true;
  });
  const page = await context.newPage();
  const issues = [];
  page.on('console', (message) => {
    if (['warning', 'error'].includes(message.type())) issues.push({ type: message.type(), text: message.text() });
  });
  page.on('pageerror', (error) => issues.push({ type: 'pageerror', text: String(error?.message || error) }));
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.waitForSelector('#recursion-root', { timeout: timeoutMs });
  await page.waitForSelector('[data-recursion-pipeline-button]', { timeout: timeoutMs });

  const power = page.locator('[data-recursion-power-toggle]').first();
  if ((await power.getAttribute('aria-pressed')) === 'false') await power.click();
  const pipeline = page.locator('[data-recursion-pipeline-button]').first();
  await pipeline.click();
  await page.locator('[data-recursion-pipeline-choice-fused]').first().click();
  const mode = page.locator('[data-recursion-mode-button]').first();
  if (!(await mode.textContent()).toLowerCase().includes('auto')) {
    await mode.click();
    await page.locator('[data-recursion-mode-choice-auto]').first().click();
  }
  const enhancements = page.locator('[data-recursion-enhancements-button]').first();
  await enhancements.click();
  await page.locator('[data-recursion-enhancement-target-choice-redirect]').first().click();
  await page.waitForFunction(() => /redirect/i.test(document.querySelector('[data-recursion-enhancements-button]')?.getAttribute('aria-label') || ''), null, { timeout: timeoutMs });
  await page.waitForFunction(() => Boolean(globalThis.__recursionLiveHarnessRuntime), null, { timeout: timeoutMs });
  await installLiveEnhancementRunOracle(page);

  const message = `Card progress proof ${Date.now()}: keep the archive door, candle, Mara, and missing captain in the immediate scene. Return a concise next beat.`;
  await page.evaluate(() => {
    const hostContext = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const chat = Array.isArray(hostContext.chat) ? hostContext.chat : [];
    const baselineLength = chat.length;
    const existing = globalThis.__recursionLiveCardProgressInitialAssistant;
    existing?.stop?.();
    const monitor = {
      before: null,
      interval: null,
      originalPush: chat.push
    };
    const capture = (entries = chat.slice(baselineLength)) => {
      if (monitor.before) return;
      const message = entries.find((entry) => entry?.is_user === false && String(entry?.mes || '').trim());
      if (!message) return;
      const messageIndex = chat.indexOf(message);
      const text = String(message?.mes || '');
      const swipes = Array.isArray(message?.swipes) ? message.swipes : [];
      monitor.before = {
        chatKey: String(hostContext?.chatId || hostContext?.chat_id || hostContext?.currentChatId || 'chat'),
        messageId: Number(message?.mesid ?? messageIndex),
        swipeCount: swipes.length || (text ? 1 : 0),
        swipeId: Number(message?.swipe_id ?? 0),
        text: String(swipes[Number(message?.swipe_id ?? 0)] || text),
        marker: null
      };
    };
    const monitoredPush = function (...entries) {
      const length = Array.prototype.push.apply(this, entries);
      capture(entries);
      return length;
    };
    chat.push = monitoredPush;
    monitor.interval = setInterval(() => capture(), 5);
    monitor.stop = () => {
      clearInterval(monitor.interval);
      if (chat.push === monitoredPush) chat.push = monitor.originalPush;
    };
    globalThis.__recursionLiveCardProgressInitialAssistant = monitor;
  });
  const input = page.locator('#send_textarea, textarea#send_textarea, textarea[name="send_textarea"]').first();
  await input.fill(message);
  await page.locator('#send_but, button#send_but').first().click();
  await page.waitForFunction((sentMessage) => {
    const chat = globalThis.SillyTavern?.getContext?.()?.chat || [];
    const userIndex = chat.findLastIndex((entry) => entry?.is_user === true && String(entry?.mes || '') === sentMessage);
    return userIndex >= 0 && chat.slice(userIndex + 1).some((entry) => entry?.is_user === false && String(entry?.mes || '').trim());
  }, message, { timeout: timeoutMs });
  const status = page.locator('[data-recursion-status-trigger]').first();
  if (!await page.evaluate(() => document.querySelector('[data-recursion-status-popover]')?.hidden === false)) await status.click();
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('[data-recursion-status-popover] [data-recursion-progress-row]')];
    const hasEditorial = rows.some((row) => /editorial/i.test(String(row.dataset.recursionProgressLabel || '')));
    const active = rows.some((row) => ['running', 'pending'].includes(String(row.dataset.recursionProgressState || '')));
    return hasEditorial && !active;
  }, null, { timeout: timeoutMs });
  await page.waitForTimeout(500);
  if (!await page.evaluate(() => document.querySelector('[data-recursion-status-popover]')?.hidden === false)) await status.click();
  await page.waitForFunction(() => document.querySelector('[data-recursion-status-popover]')?.hidden === false, null, { timeout: timeoutMs });
  await page.waitForTimeout(300);

  const snapshot = await page.evaluate((sentMessage) => {
    const popover = document.querySelector('[data-recursion-status-popover]');
    const rows = [...(popover?.querySelectorAll('[data-recursion-progress-row]') || [])].map((row) => ({
      label: String(row.querySelector('[data-recursion-progress-label]')?.textContent || '').replace(/\s+/g, ' ').trim(),
      state: row.dataset.recursionProgressState || '',
      meta: String(row.querySelector('[data-recursion-progress-meta]')?.textContent || '').replace(/\s+/g, ' ').trim(),
      parent: row.parentElement?.dataset?.recursionProgressParentStep || ''
    }));
    const runtime = globalThis.__recursionLiveHarnessRuntime;
    const runtimeView = runtime?.view?.() || {};
    const hostContext = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const chat = Array.isArray(hostContext.chat) ? hostContext.chat : [];
    const userIndex = chat.findLastIndex((entry) => entry?.is_user === true && String(entry?.mes || '') === sentMessage);
    const assistantIndex = chat.findIndex((entry, index) => (
      index > userIndex && entry?.is_user === false && String(entry?.mes || '').trim()
    ));
    const assistant = assistantIndex >= 0 ? chat[assistantIndex] : null;
    const messageId = Number(assistant?.mesid ?? assistantIndex);
    const swipeId = Number(assistant?.swipe_id ?? 0);
    const swipeCount = Array.isArray(assistant?.swipes) ? assistant.swipes.length : 0;
    const indexedMarker = Array.isArray(assistant?.__recursionGenerationReviewSwipes)
      ? assistant.__recursionGenerationReviewSwipes[swipeId] || null
      : null;
    const swipeInfoMarker = Array.isArray(assistant?.swipe_info)
      ? assistant.swipe_info[swipeId]?.extra?.recursion?.enhancement || null
      : null;
    const marker = indexedMarker || swipeInfoMarker || assistant?.__recursionGenerationReview || null;
    const sourceState = globalThis.__recursionLiveCardProgressInitialAssistant?.before || null;
    globalThis.__recursionLiveCardProgressInitialAssistant?.stop?.();
    delete globalThis.__recursionLiveCardProgressInitialAssistant;
    const chatKey = String(hostContext?.chatId || hostContext?.chat_id || hostContext?.currentChatId || 'chat');
    const editorialResult = runtimeView.editorialResult || null;
    return {
      popoverOpen: popover?.hidden === false,
      enhancementMode: document.querySelector('[data-recursion-enhancements-button]')?.getAttribute('aria-label') || '',
      title: String(popover?.querySelector('[data-recursion-progress-title]')?.textContent || '').replace(/\s+/g, ' ').trim(),
      subtitle: String(popover?.querySelector('[data-recursion-progress-subtitle]')?.textContent || '').replace(/\s+/g, ' ').trim(),
      rows,
      text: String(popover?.textContent || '').replace(/\s+/g, ' ').trim(),
      assistantFound: Boolean(assistant),
      certification: {
        enhancement: { enabled: true, mode: 'redirect', applyMode: 'as-swipe' },
        before: sourceState || {},
        after: {
          chatKey,
          messageId,
          swipeCount,
          swipeId,
          text: String(assistant?.mes || ''),
          marker
        },
        enhancementResult: {
          ok: editorialResult?.status === 'success',
          skipped: editorialResult?.status === 'skipped',
          partialFailed: editorialResult?.status === 'partial-failed',
          mode: String(editorialResult?.mode || marker?.mode || ''),
          marker
        },
        editorialResult
      }
    };
  }, message);
  const certification = snapshot.certification;
  delete snapshot.certification;
  const oracle = await collectLiveEnhancementRunOracle(page, {
    enhancement: certification.enhancement,
    before: certification.before,
    after: certification.after,
    enhancementResult: certification.enhancementResult,
    editorialResult: certification.editorialResult
  });
  await page.screenshot({ path: resolve(artifactDir, 'desktop.png'), fullPage: false });
  await page.setViewportSize({ width: 420, height: 900 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(artifactDir, 'mobile.png'), fullPage: false });
  const healthyTerminalStates = new Set(['done', 'cached', 'skipped']);
  const unhealthyRows = snapshot.rows.filter((row) => !healthyTerminalStates.has(row.state));
  const promptReady = snapshot.rows.some((row) => /recursion prompt ready/i.test(row.label) && row.state === 'done');
  const failures = [
    ...(!snapshot.popoverOpen ? ['progress-popover-closed'] : []),
    ...(!snapshot.assistantFound ? ['generated-assistant-message-missing'] : []),
    ...(snapshot.rows.length === 0 ? ['progress-tree-empty'] : []),
    ...(unhealthyRows.length ? ['progress-tree-unhealthy'] : []),
    ...(!promptReady ? ['prompt-ready-not-done'] : []),
    ...(!oracle.verdict.ok ? oracle.verdict.failures : [])
  ];
  const statusValue = failures.length ? 'fail' : 'pass';
  console.log(JSON.stringify({ status: statusValue, user, snapshot, unhealthyRows, promptReady, oracle, failures, issues, artifactDir }, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
}
