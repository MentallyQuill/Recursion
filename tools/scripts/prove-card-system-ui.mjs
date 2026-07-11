import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';
import {
  createRunId,
  createSillyTavernHttpSession,
  validateSoakUserHandle,
  writeReportArtifacts
} from './lib/sillytavern-live-harness.mjs';

const DEFAULT_TIMEOUT_MS = 240000;

function nowIso() {
  return new Date().toISOString();
}

function hasArg(name) {
  return process.argv.slice(2).includes(name);
}

function passwordEnvKey(user) {
  return `RECURSION_SILLYTAVERN_PASSWORD_${String(user).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function passwordForUser(user, env) {
  return env[passwordEnvKey(user)] ?? env.RECURSION_SILLYTAVERN_PASSWORD ?? '';
}

function reportBase(runId, mode, dryRun) {
  const startedAt = nowIso();
  return {
    recordType: 'recursion.liveHarnessReport',
    schemaVersion: 1,
    runId,
    scriptName: 'prove-card-system-ui',
    status: 'pass',
    result: dryRun ? 'dry-run-pass' : 'card-system-ui-pass',
    startedAt,
    generatedAt: startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    mode,
    dryRun,
    strict: hasArg('--strict'),
    checks: [],
    warnings: [],
    failures: [],
    environment: {
      baseUrlConfigured: Boolean(process.env.SILLYTAVERN_BASE_URL),
      userConfigured: Boolean(process.env.RECURSION_SILLYTAVERN_USER),
      liveGeneration: false
    },
    nextAction: dryRun ? 'Run with --live against a dedicated recursion-soak-* user.' : 'Card System UI proof passed.'
  };
}

function addCheck(report, name, status, summary, details = {}) {
  const check = { name, status, summary, details };
  report.checks.push(check);
  if (status !== 'pass') {
    report.status = status === 'unsafe-user' ? 'unsafe-user' : 'fail';
    report.result = status;
    report.failures.push(check);
  }
}

function finish(report) {
  report.generatedAt = nowIso();
  report.finishedAt = report.generatedAt;
  report.durationMs = Math.max(0, Date.parse(report.finishedAt) - Date.parse(report.startedAt));
  return report;
}

function fail(report, name, summary, details = {}) {
  addCheck(report, name, 'fail', summary, details);
  throw Object.assign(new Error(summary), { report });
}

function assertLivePreflight(report, env) {
  if (!env.SILLYTAVERN_BASE_URL) fail(report, 'base-url', 'SILLYTAVERN_BASE_URL is required.');
  const userResult = validateSoakUserHandle(env.RECURSION_SILLYTAVERN_USER);
  if (!userResult.ok) {
    addCheck(report, 'dedicated-user-policy', userResult.status, 'Configured user is not safe for live Card System proof.', userResult);
    const error = new Error('Unsafe or missing dedicated live-test user.');
    error.report = report;
    throw error;
  }
  addCheck(report, 'dedicated-user-policy', 'pass', 'Dedicated recursion soak user accepted.', userResult);
  return userResult.user;
}

async function waitForRecursion(page, timeoutMs) {
  await page.waitForSelector('#recursion-root', { timeout: timeoutMs });
  await page.waitForSelector('[data-recursion-cards-button]', { timeout: timeoutMs });
}

async function openCards(page, timeoutMs) {
  const alreadyOpen = await page.evaluate(() => document.querySelector('[data-recursion-cards-panel]')?.hidden === false).catch(() => false);
  if (alreadyOpen) return;
  await page.locator('[data-recursion-cards-button]').first().click({ timeout: timeoutMs });
  await page.waitForFunction(() => document.querySelector('[data-recursion-cards-panel]')?.hidden === false, null, { timeout: timeoutMs });
}

async function runCardSystemScenario(page, report, timeoutMs) {
  const cardName = `Scene Boundary ${report.runId.slice(-6)}`;
  await openCards(page, timeoutMs);
  await page.evaluate(() => {
    const select = document.querySelector('[data-recursion-card-deck-select]');
    if (!select) return;
    select.value = 'default';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const panel = document.querySelector('[data-recursion-cards-panel]');
    const select = document.querySelector('[data-recursion-card-deck-select]');
    return select?.value === 'default' && /Default is read-only/.test(String(panel?.textContent || ''));
  }, null, { timeout: timeoutMs });
  const initial = await page.evaluate(() => ({
    panelVisible: document.querySelector('[data-recursion-cards-panel]')?.hidden === false,
    deckSelect: Boolean(document.querySelector('[data-recursion-card-deck-select]')),
    defaultReadonlyNotice: /Default is read-only/.test(String(document.querySelector('[data-recursion-cards-panel]')?.textContent || '')),
    categoryRows: document.querySelectorAll('[data-recursion-card-deck-category]').length,
    legacyScopeRows: document.querySelectorAll('[data-recursion-card-scope-family]').length
  }));
  if (!initial.panelVisible || !initial.deckSelect || !initial.defaultReadonlyNotice || initial.categoryRows < 1 || initial.legacyScopeRows !== 0) {
    fail(report, 'default-deck-ui', 'Default Card System panel did not render expected controls.', initial);
  }
  addCheck(report, 'default-deck-ui', 'pass', 'Default read-only Card System panel rendered.', initial);

  await page.locator('[data-recursion-card-deck-duplicate]').first().click({ timeout: timeoutMs });
  try {
    await page.waitForFunction(() => {
      const view = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
      return view.settings?.cardDecks?.activeCardDeckId && view.settings.cardDecks.activeCardDeckId !== 'default';
    }, null, { timeout: timeoutMs });
  } catch {
    fail(report, 'deck-duplicate', 'Duplicating Default did not activate a custom Card Deck.', await cardSystemState(page));
  }
  addCheck(report, 'deck-duplicate', 'pass', 'Default deck duplicate activated an editable custom deck.', await cardSystemState(page));
  const duplicatedState = await cardSystemState(page);
  await page.locator('[data-recursion-card-category-new]').first().click({ timeout: timeoutMs });
  await page.waitForFunction((previousCount) => {
    const view = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
    const deck = view.settings?.cardDecks?.customCardDecks?.[view.settings?.cardDecks?.activeCardDeckId];
    return Object.keys(deck?.categories || {}).length > previousCount;
  }, duplicatedState.categoryCount, { timeout: timeoutMs });
  const categorizedState = await cardSystemState(page);
  await page.locator('[data-recursion-card-new]').first().click({ timeout: timeoutMs });
  await page.waitForSelector('[data-recursion-card-editor]', { timeout: timeoutMs });
  await page.waitForFunction((previousCount) => {
    const view = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
    const deck = view.settings?.cardDecks?.customCardDecks?.[view.settings?.cardDecks?.activeCardDeckId];
    return Object.keys(deck?.cards || {}).length > previousCount;
  }, categorizedState.cardCount, { timeout: timeoutMs });
  await page.waitForFunction(() => /Draft card created/.test(String(document.querySelector('[data-recursion-cards-panel]')?.textContent || ''))
    && Boolean(document.querySelector('[data-recursion-card-editor-name]')), null, { timeout: timeoutMs });
  await page.evaluate((draft) => {
    const name = document.querySelector('[data-recursion-card-editor-name]');
    const description = document.querySelector('[data-recursion-card-editor-description]');
    const prompt = document.querySelector('[data-recursion-card-editor-prompt]');
    for (const [node, value] of [[name, draft.name], [description, draft.description], [prompt, draft.promptText]]) {
      if (!node) continue;
      node.value = value;
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, {
    name: cardName,
    description: 'Keeps the immediate scene boundary visible.',
    promptText: 'Keep the current room boundary and pending interruption visible only when it affects the next beat.'
  });
  await page.waitForFunction((expectedName) => document.querySelector('[data-recursion-card-editor-name]')?.value === expectedName, cardName, { timeout: timeoutMs });
  await page.locator('[data-recursion-card-editor-save]').click({ timeout: timeoutMs });
  try {
    await page.waitForFunction((expectedName) => {
      const view = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
      const deck = view.settings?.cardDecks?.customCardDecks?.[view.settings?.cardDecks?.activeCardDeckId];
      return Object.values(deck?.cards || {}).some((card) => card.name === expectedName && card.promptText);
    }, cardName, { timeout: timeoutMs });
  } catch {
    fail(report, 'card-editor-save', 'Card editor save did not persist the expected card on the active deck.', {
      expectedName: cardName,
      ...(await cardSystemState(page))
    });
  }

  const custom = await page.evaluate((expectedName) => {
    const view = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
    const decks = view.settings?.cardDecks?.customCardDecks || {};
    const deck = decks[view.settings?.cardDecks?.activeCardDeckId] || Object.values(decks)[0] || {};
    return {
      activeDeckId: view.settings?.cardDecks?.activeCardDeckId || '',
      categoryCount: Object.keys(deck.categories || {}).length,
      cardCount: Object.keys(deck.cards || {}).length,
      hasSceneBoundary: Object.values(deck.cards || {}).some((card) => card.name === expectedName),
      editableControls: Boolean(document.querySelector('[data-recursion-card-category-new]'))
        && Boolean(document.querySelector('[data-recursion-card-duplicate]'))
        && Boolean(document.querySelector('[data-recursion-card-delete-arm]'))
        && Boolean(document.querySelector('[data-recursion-card-move]'))
    };
  }, cardName);
  if (!custom.activeDeckId || custom.categoryCount < 1 || !custom.hasSceneBoundary || !custom.editableControls) {
    fail(report, 'custom-deck-ui', 'Custom Card Deck controls did not persist expected edits.', custom);
  }
  addCheck(report, 'custom-deck-ui', 'pass', 'Custom deck category/card/editor controls worked.', custom);

  const createdCardId = await page.evaluate((expectedName) => {
    const view = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
    const deck = view.settings?.cardDecks?.customCardDecks?.[view.settings?.cardDecks?.activeCardDeckId];
    return Object.values(deck?.cards || {}).find((card) => card.name === expectedName)?.id || '';
  }, cardName);
  if (!createdCardId) fail(report, 'card-row-state', 'Could not locate saved card id for row-state proof.', await cardSystemState(page));
  const rowSelector = `[data-recursion-card-id="${createdCardId}"]`;
  await page.locator(`${rowSelector} [data-recursion-card-toggle-row]`).click({ timeout: timeoutMs });
  await page.waitForFunction((cardId) => {
    const row = document.querySelector(`[data-recursion-card-id="${cardId}"]`);
    const view = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
    const deck = view.settings?.cardDecks?.customCardDecks?.[view.settings?.cardDecks?.activeCardDeckId];
    return row?.classList?.contains('is-inactive') && deck?.cards?.[cardId]?.enabled === false;
  }, createdCardId, { timeout: timeoutMs });
  await page.locator(`${rowSelector} [data-recursion-card-toggle-row]`).click({ timeout: timeoutMs });
  await page.waitForFunction((cardId) => {
    const row = document.querySelector(`[data-recursion-card-id="${cardId}"]`);
    const view = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
    const deck = view.settings?.cardDecks?.customCardDecks?.[view.settings?.cardDecks?.activeCardDeckId];
    return row?.classList?.contains('is-active') && deck?.cards?.[cardId]?.enabled !== false;
  }, createdCardId, { timeout: timeoutMs });
  addCheck(report, 'card-row-state', 'pass', 'Card row tap toggled inactive and active states without an eye button.', await cardSystemState(page));

  await page.locator(`${rowSelector} [data-recursion-card-delete-arm]`).click({ timeout: timeoutMs });
  await page.waitForSelector(`${rowSelector}.is-delete-pending [data-recursion-card-delete-confirm]`, { timeout: timeoutMs });
  await page.locator(`${rowSelector} [data-recursion-card-delete-cancel]`).click({ timeout: timeoutMs });
  await page.waitForFunction((cardId) => !document.querySelector(`[data-recursion-card-id="${cardId}"]`)?.classList?.contains('is-delete-pending'), createdCardId, { timeout: timeoutMs });
  await page.locator(`${rowSelector} [data-recursion-card-delete-arm]`).click({ timeout: timeoutMs });
  await page.locator(`${rowSelector} [data-recursion-card-delete-confirm]`).click({ timeout: timeoutMs });
  await page.waitForFunction((cardId) => {
    const view = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
    const deck = view.settings?.cardDecks?.customCardDecks?.[view.settings?.cardDecks?.activeCardDeckId];
    return !deck?.cards?.[cardId] && !document.querySelector(`[data-recursion-card-id="${cardId}"]`);
  }, createdCardId, { timeout: timeoutMs });
  addCheck(report, 'card-delete-confirm', 'pass', 'Card delete cancel preserved the card and confirm removed it.', await cardSystemState(page));
}

async function screenshotCards(page, artifactDir, name, timeoutMs) {
  const path = resolve(artifactDir, 'screenshots', `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  await page.locator('[data-recursion-cards-panel]').first().screenshot({ path, timeout: timeoutMs });
  return path.replace(/\\/g, '/');
}

async function cardSystemState(page) {
  return page.evaluate(() => {
    const view = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
    const decks = view.settings?.cardDecks?.customCardDecks || {};
    const activeDeckId = view.settings?.cardDecks?.activeCardDeckId || '';
    const deck = decks[activeDeckId] || {};
    return {
      activeDeckId,
      deckName: deck.name || '',
      categoryCount: Object.keys(deck.categories || {}).length,
      cardCount: Object.keys(deck.cards || {}).length,
      cardNames: Object.values(deck.cards || {}).map((card) => card.name).slice(-12),
      panelText: String(document.querySelector('[data-recursion-cards-panel]')?.textContent || '').slice(0, 400)
    };
  }).catch((error) => ({ error: error?.message || String(error) }));
}

async function main() {
  const live = hasArg('--live');
  const writeArtifacts = hasArg('--write-artifacts');
  const runId = createRunId('card-system-ui');
  const report = reportBase(runId, live ? 'live' : 'dry-run', !live);
  const artifactRoot = process.env.RECURSION_ARTIFACT_DIR || resolve('artifacts');
  if (!live) {
    addCheck(report, 'dry-run', 'pass', 'Dry run did not contact SillyTavern.');
    const finished = finish(report);
    if (writeArtifacts) writeReportArtifacts(finished, { artifactRoot, family: 'live-smoke/card-system' });
    return finished;
  }

  let browser = null;
  try {
    const user = assertLivePreflight(report, process.env);
    const timeoutMs = Number(process.env.RECURSION_LIVE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    const session = createSillyTavernHttpSession({
      baseUrl: process.env.SILLYTAVERN_BASE_URL,
      user,
      password: passwordForUser(user, process.env)
    });
    await session.init();
    await session.login();
    browser = await chromium.launch({ headless: process.env.RECURSION_SILLYTAVERN_HEADLESS !== '0' });
    const artifactDir = resolve(artifactRoot, 'live-smoke/card-system', runId);
    const context = await browser.newContext({ viewport: { width: 1360, height: 820 } });
    await context.addCookies(session.playwrightCookies());
    await context.addInitScript(() => { globalThis.__recursionLiveHarness = true; });
    if (typeof context.tracing?.start === 'function' && writeArtifacts) await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    await page.goto(process.env.SILLYTAVERN_BASE_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await waitForRecursion(page, timeoutMs);
    await runCardSystemScenario(page, report, timeoutMs);
    const desktopShot = writeArtifacts ? await screenshotCards(page, artifactDir, 'desktop', timeoutMs) : '';
    await page.setViewportSize({ width: 390, height: 720 });
    await openCards(page, timeoutMs);
    const phone = await page.evaluate(() => {
      const panel = document.querySelector('[data-recursion-cards-panel]');
      const rect = panel?.getBoundingClientRect?.() || {};
      return {
        visible: panel?.hidden === false,
        width: Math.round(rect.width || 0),
        hasEditor: Boolean(document.querySelector('[data-recursion-card-editor]')),
        hasDeckSelect: Boolean(document.querySelector('[data-recursion-card-deck-select]'))
      };
    });
    if (!phone.visible || !phone.hasDeckSelect) fail(report, 'phone-layout', 'Phone Card System layout did not render compact controls.', phone);
    addCheck(report, 'phone-layout', 'pass', 'Phone viewport renders Card System controls.', phone);
    const phoneShot = writeArtifacts ? await screenshotCards(page, artifactDir, 'phone', timeoutMs) : '';
    if (writeArtifacts && typeof context.tracing?.stop === 'function') {
      mkdirSync(resolve(artifactDir, 'playwright'), { recursive: true });
      await context.tracing.stop({ path: resolve(artifactDir, 'playwright', 'trace.zip') });
    }
    report.artifacts = {
      ...(report.artifacts || {}),
      desktopScreenshot: desktopShot,
      phoneScreenshot: phoneShot,
      trace: writeArtifacts ? 'playwright/trace.zip' : undefined
    };
    const finished = finish(report);
    if (writeArtifacts) writeReportArtifacts(finished, { artifactRoot, family: 'live-smoke/card-system' });
    return finished;
  } catch (error) {
    const failed = finish(error.report || report);
    if (!failed.failures.length) addCheck(failed, 'card-system-ui-error', 'fail', error?.message || 'Card System UI proof failed.');
    if (writeArtifacts) writeReportArtifacts(failed, { artifactRoot, family: 'live-smoke/card-system' });
    return failed;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

const report = await main();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.status === 'pass' ? 0 : 1;
