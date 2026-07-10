import { chromium } from 'playwright';
import {
  createRunId,
  createSillyTavernHttpSession,
  validateSoakUserHandle
} from './lib/sillytavern-live-harness.mjs';

function envValue(name, fallback = '') {
  return String(process.env[name] ?? fallback).trim();
}

function fail(result, message, details = {}) {
  const error = new Error(message);
  error.result = result;
  error.details = details;
  throw error;
}

async function visibleText(locator) {
  return String(await locator.textContent({ timeout: 10000 }) || '').replace(/\s+/g, ' ').trim();
}

const baseUrl = envValue('SILLYTAVERN_BASE_URL', 'http://127.0.0.1:8000');
const user = envValue('RECURSION_SILLYTAVERN_USER', 'recursion-soak-a');
const password = envValue('RECURSION_SILLYTAVERN_PASSWORD', envValue('SILLYTAVERN_PASSWORD', ''));
const userValidation = validateSoakUserHandle(user);
if (!userValidation.ok) fail('unsafe-user', 'RECURSION_SILLYTAVERN_USER must be a dedicated recursion-soak-* user.', { user, reason: userValidation.reason });

const runId = createRunId('prove-live-story-form-selector');
const report = {
  recordType: 'recursion.liveStoryFormSelectorProof',
  schemaVersion: 1,
  runId,
  baseUrl,
  user,
  startedAt: new Date().toISOString(),
  status: 'running',
  checks: []
};

let browser;
try {
  const session = createSillyTavernHttpSession({ baseUrl, user, password });
  await session.login();
  browser = await chromium.launch({ headless: true });
  const browserContext = await browser.newContext({ viewport: { width: 1040, height: 760 } });
  await browserContext.addCookies(session.playwrightCookies());
  await browserContext.addInitScript(() => {
    globalThis.__recursionLiveHarness = true;
  });
  const page = await browserContext.newPage();
  page.setDefaultTimeout(120000);
  await page.goto(`${baseUrl}/?recursionStoryFormProof=${encodeURIComponent(runId)}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('#recursion-root', { state: 'visible', timeout: 120000 });
  await page.waitForFunction(() => Boolean(globalThis.__recursionLiveHarnessRuntime), null, { timeout: 120000 });

  await page.evaluate(async () => {
    const runtime = globalThis.__recursionLiveHarnessRuntime;
    await runtime.updateSettings({ enabled: true, storyFormOverride: 'auto' });
  });

  const button = page.locator('[data-recursion-story-form-button]');
  const menu = page.locator('[data-recursion-story-form-menu]');
  await button.click();
  await menu.waitFor({ state: 'visible' });

  const menuText = await visibleText(menu);
  const hasAxisUi = ['Auto', 'Tense', 'Past', 'Present', 'Point of View', '1st', '2nd', '3rd Ltd', '3rd Omni', 'Mixed']
    .every((text) => menuText.includes(text));
  const flatChoiceCount = await page.locator('[data-recursion-story-form-choice]').count();
  report.checks.push({
    name: 'axis-menu-rendered',
    status: hasAxisUi && flatChoiceCount === 0 ? 'pass' : 'fail',
    details: { hasAxisUi, flatChoiceCount, menuText }
  });
  if (!hasAxisUi || flatChoiceCount !== 0) fail('axis-menu-render-failed', 'Story form menu did not render axis selector.', { hasAxisUi, flatChoiceCount, menuText });

  await page.locator('[data-recursion-story-form-pov-mixed]').click();
  const afterMixed = await page.evaluate(() => globalThis.__recursionLiveHarnessRuntime.view().settings.storyFormOverride);
  const menuStillOpenAfterMixed = await menu.isVisible();
  const compactAfterMixed = await visibleText(page.locator('[data-recursion-story-form]'));
  report.checks.push({
    name: 'mixed-from-auto',
    status: afterMixed === 'past-mixed' && menuStillOpenAfterMixed && compactAfterMixed === 'Past Mixed' ? 'pass' : 'fail',
    details: { afterMixed, menuStillOpenAfterMixed, compactAfterMixed }
  });
  if (afterMixed !== 'past-mixed' || !menuStillOpenAfterMixed) fail('mixed-from-auto-failed', 'Mixed from Auto did not save past-mixed while keeping menu open.', { afterMixed, menuStillOpenAfterMixed, compactAfterMixed });

  await page.locator('[data-recursion-story-form-tense-present]').click();
  const afterPresent = await page.evaluate(() => globalThis.__recursionLiveHarnessRuntime.view().settings.storyFormOverride);
  const presentSelected = await page.locator('[data-recursion-story-form-tense-present]').getAttribute('aria-pressed');
  const mixedSelected = await page.locator('[data-recursion-story-form-pov-mixed]').getAttribute('aria-pressed');
  report.checks.push({
    name: 'present-preserves-mixed',
    status: afterPresent === 'present-mixed' && presentSelected === 'true' && mixedSelected === 'true' ? 'pass' : 'fail',
    details: { afterPresent, presentSelected, mixedSelected }
  });
  if (afterPresent !== 'present-mixed' || presentSelected !== 'true' || mixedSelected !== 'true') {
    fail('present-preserves-mixed-failed', 'Present tense did not preserve Mixed POV selected state.', { afterPresent, presentSelected, mixedSelected });
  }

  await page.locator('[data-recursion-story-form-auto-choice]').click();
  const afterAuto = await page.evaluate(() => globalThis.__recursionLiveHarnessRuntime.view().settings.storyFormOverride);
  const menuClosedAfterAuto = !(await menu.isVisible());
  const compactAfterAuto = await visibleText(page.locator('[data-recursion-story-form]'));
  report.checks.push({
    name: 'auto-closes',
    status: afterAuto === 'auto' && menuClosedAfterAuto && compactAfterAuto === 'Auto' ? 'pass' : 'fail',
    details: { afterAuto, menuClosedAfterAuto, compactAfterAuto }
  });
  if (afterAuto !== 'auto' || !menuClosedAfterAuto || compactAfterAuto !== 'Auto') {
    fail('auto-close-failed', 'Auto did not save auto and close menu.', { afterAuto, menuClosedAfterAuto, compactAfterAuto });
  }

  report.status = 'pass';
  report.result = 'story-form-selector-live-pass';
} catch (error) {
  report.status = error?.result ? 'fail' : 'environment-fail';
  report.result = error?.result || 'story-form-selector-live-error';
  report.error = {
    message: String(error?.message || error),
    details: error?.details || null
  };
} finally {
  if (browser) await browser.close().catch(() => {});
  report.finishedAt = new Date().toISOString();
}

console.log(JSON.stringify(report, null, 2));
if (report.status !== 'pass') process.exitCode = 1;
