import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { assertVisualBaseline } from './lib/visual-regression.mjs';
import { createSillyTavernHttpSession, validateSoakUserHandle } from './lib/sillytavern-live-harness.mjs';

const pipelines = ['standard', 'rapid', 'fused'];
const modes = ['off', 'repair', 'recompose', 'redirect'];
const viewports = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'compact', width: 390, height: 844 }];
const outDir = resolve('artifacts', 'editorial-ui');
const dryRun = process.argv.includes('--dry-run') || !process.env.SILLYTAVERN_BASE_URL;

function check(condition, message) { if (!condition) throw new Error(message); }
function digest(buffer) { return createHash('sha256').update(buffer).digest('hex'); }

if (dryRun) {
  const cases = pipelines.flatMap((pipeline) => modes.flatMap((mode) => viewports.map((viewport) => ({ pipeline, mode, viewport: viewport.name }))));
  console.log(JSON.stringify({ schema: 'recursion.editorialUiMatrix.v1', status: 'dry-run-pass', cases }, null, 2));
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const report = { schema: 'recursion.editorialUiMatrix.v1', status: 'pass', cases: [], failures: [] };
try {
  const user = process.env.RECURSION_SILLYTAVERN_USER || '';
  check(validateSoakUserHandle(user).ok, 'RECURSION_SILLYTAVERN_USER must be a dedicated recursion-soak-* user');
  const session = createSillyTavernHttpSession({ baseUrl: process.env.SILLYTAVERN_BASE_URL, user, password: process.env.RECURSION_SILLYTAVERN_PASSWORD || '' });
  await session.login();
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });
    await context.addCookies(session.playwrightCookies());
    const page = await context.newPage();
    const browserErrors = [];
    page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') browserErrors.push(`${message.type()}: ${message.text()}`); });
    await page.goto(process.env.SILLYTAVERN_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForSelector('#recursion-root', { timeout: 120000 });
    for (const pipeline of pipelines) {
      for (const mode of modes) {
        const key = `${pipeline}-${mode}-${viewport.name}`;
        try {
          await page.locator('[data-recursion-pipeline-button]').click();
          await page.locator(`[data-recursion-pipeline-choice-${pipeline}]`).click();
          await page.waitForTimeout(150);
          await page.locator('[data-recursion-enhancements-button]').click();
          await page.locator(`[data-recursion-enhancement-target-choice-${mode}]`).click();
          await page.waitForFunction((expected) => {
            const label = document.querySelector('[data-recursion-enhancements-button]')?.getAttribute('aria-label') || '';
            return label.toLowerCase().includes(expected);
          }, mode, { timeout: 3000 });
          await page.waitForTimeout(300);
          const state = await page.evaluate(() => ({
            missing: ['#recursion-root', '[data-recursion-mode-button]', '[data-recursion-pipeline-button]', '[data-recursion-cards-button]', '[data-recursion-enhancements-button]', '[data-recursion-options-button]', '[data-recursion-activity-ribbon]', '[data-recursion-progress-list]', '[data-recursion-editorial-inspector]'].filter((selector) => !document.querySelector(selector)),
            caution: [...document.querySelectorAll('[data-recursion-caution], [data-recursion-error], .recursion-caution, .recursion-error')].filter((node) => !node.hidden).map((node) => node.textContent?.trim()).filter(Boolean),
            mode: document.querySelector('[data-recursion-enhancements-button]')?.getAttribute('aria-label') || '',
            pipeline: document.querySelector('[data-recursion-pipeline-button]')?.getAttribute('aria-label') || ''
          }));
          check(state.missing.length === 0, `${key}: missing UI components: ${state.missing.join(', ')}`);
          check(browserErrors.length === 0, `${key}: browser/console errors: ${browserErrors.join(' | ')}`);
          check(state.caution.length === 0, `${key}: visible caution/error: ${state.caution.join(' | ')}`);
          check(state.mode.toLowerCase().includes(mode), `${key}: mode not selected (${state.mode})`);
          check(state.pipeline.toLowerCase().includes(pipeline), `${key}: pipeline not selected (${state.pipeline})`);
          const states = ['enhancement-menu', 'editorial-inspector'];
          for (const state of states) {
            const shot = await page.screenshot({ fullPage: true });
            const path = resolve(outDir, `${key}-${state}.png`);
            writeFileSync(path, shot);
            if (process.env.EDITORIAL_UI_VISUAL_BASELINES === '1') {
              const baselinePath = resolve('tests', 'visual-baselines', 'editorial-transformation', viewport.name, pipeline, mode, `${state}.png`);
              if (process.env.UPDATE_VISUAL_BASELINES === '1') {
                mkdirSync(resolve('tests', 'visual-baselines', 'editorial-transformation', viewport.name, pipeline, mode), { recursive: true });
                await page.locator('#recursion-root').screenshot({ path: baselinePath, animations: 'disabled', caret: 'hide', scale: 'css', mask: [page.locator('#recursion-root [data-recursion-visual-volatile]')] });
              } else {
                await assertVisualBaseline(page.locator('#recursion-root'), baselinePath, { mask: ['[data-recursion-visual-volatile]'] });
              }
            }
            report.cases.push({ key, pipeline, mode, viewport: viewport.name, state, screenshot: path, sha256: digest(shot), status: 'pass' });
            if (state === 'enhancement-menu') await page.locator('[data-recursion-enhancements-button]').click();
          }
        } catch (error) {
          report.status = 'fail';
          report.failures.push({ key, message: String(error?.message || error) });
        }
      }
    }
    await context.close();
  }
} finally {
  await browser.close();
}
writeFileSync(resolve(outDir, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'pass') process.exitCode = 1;
