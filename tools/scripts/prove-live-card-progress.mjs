import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { createSillyTavernHttpSession, validateSoakUserHandle } from './lib/sillytavern-live-harness.mjs';

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

  const before = await page.evaluate(() => globalThis.SillyTavern?.getContext?.()?.chat?.length || 0);
  const message = `Card progress proof ${Date.now()}: keep the archive door, candle, Mara, and missing captain in the immediate scene. Return a concise next beat.`;
  const input = page.locator('#send_textarea, textarea#send_textarea, textarea[name="send_textarea"]').first();
  await input.fill(message);
  await page.locator('#send_but, button#send_but').first().click();
  await page.waitForFunction((expected) => (globalThis.SillyTavern?.getContext?.()?.chat?.length || 0) >= expected + 2, before, { timeout: timeoutMs });
  await page.waitForTimeout(1000);

  const status = page.locator('[data-recursion-status-trigger]').first();
  await status.click();
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
      rows,
      text: String(popover?.textContent || '').replace(/\s+/g, ' ').trim()
    };
  });
  await page.screenshot({ path: resolve(artifactDir, 'desktop.png'), fullPage: false });
  await page.setViewportSize({ width: 420, height: 900 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(artifactDir, 'mobile.png'), fullPage: false });
  console.log(JSON.stringify({ status: 'pass', user, snapshot, issues, artifactDir }, null, 2));
  if (!snapshot.popoverOpen) process.exitCode = 1;
  if (snapshot.rows.some((row) => row.label === 'location/situation' && row.state === 'failed')) process.exitCode = 2;
} finally {
  await browser.close().catch(() => {});
}
