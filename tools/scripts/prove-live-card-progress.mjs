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

  const snapshot = await page.evaluate(() => {
    const popover = document.querySelector('[data-recursion-status-popover]');
    const rows = [...(popover?.querySelectorAll('[data-recursion-progress-row]') || [])].map((row) => ({
      label: String(row.querySelector('[data-recursion-progress-label]')?.textContent || '').replace(/\s+/g, ' ').trim(),
      state: row.dataset.recursionProgressState || '',
      meta: String(row.querySelector('[data-recursion-progress-meta]')?.textContent || '').replace(/\s+/g, ' ').trim(),
      parent: row.parentElement?.dataset?.recursionProgressParentStep || ''
    }));
    return {
      popoverOpen: popover?.hidden === false,
      enhancementMode: document.querySelector('[data-recursion-enhancements-button]')?.getAttribute('aria-label') || '',
      title: String(popover?.querySelector('[data-recursion-progress-title]')?.textContent || '').replace(/\s+/g, ' ').trim(),
      subtitle: String(popover?.querySelector('[data-recursion-progress-subtitle]')?.textContent || '').replace(/\s+/g, ' ').trim(),
      rows,
      text: String(popover?.textContent || '').replace(/\s+/g, ' ').trim()
    };
  });
  const oracle = await collectLiveEnhancementRunOracle(page);
  await page.screenshot({ path: resolve(artifactDir, 'desktop.png'), fullPage: false });
  await page.setViewportSize({ width: 420, height: 900 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(artifactDir, 'mobile.png'), fullPage: false });
  const healthyTerminalStates = new Set(['done', 'cached', 'skipped']);
  const unhealthyRows = snapshot.rows.filter((row) => !healthyTerminalStates.has(row.state));
  const promptReady = snapshot.rows.some((row) => /recursion prompt ready/i.test(row.label) && row.state === 'done');
  const failures = [
    ...(!snapshot.popoverOpen ? ['progress-popover-closed'] : []),
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
