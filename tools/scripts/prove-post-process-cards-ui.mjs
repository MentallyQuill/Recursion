import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { DEFAULT_PRE_PROCESS_DECK_ID } from '../../src/pre-process-decks.mjs';
import { assertVisualBaselineBuffer } from './lib/visual-regression.mjs';
import { runWithRetainedTrace } from './lib/trace-lifecycle.mjs';
import {
  createRunId,
  createSillyTavernHttpSession,
  validateSoakUserHandle
} from './lib/sillytavern-live-harness.mjs';
import {
  productionFilePaths,
  verifyInstalledCopies
} from './verify-installed-copy.mjs';

const VIEWPORTS = Object.freeze([
  { name: 'desktop', width: 1360, height: 820, hasTouch: false },
  { name: 'compact', width: 390, height: 844, hasTouch: true }
]);
const STATES = Object.freeze([
  'starter-off',
  'starter-unified',
  'starter-progressive',
  'custom-deck',
  'card-editor',
  'delete-confirm'
]);
const REQUIRED_SELECTORS = Object.freeze([
  'data-recursion-pre-process-cards-button',
  'data-recursion-post-process-cards-button',
  'data-recursion-post-process-panel',
  'data-recursion-post-process-enabled',
  'data-recursion-post-process-deck-select',
  'data-recursion-post-process-deck-duplicate',
  'data-recursion-post-process-deck-new',
  'data-recursion-post-process-deck-edit',
  'data-recursion-post-process-deck-delete',
  'data-recursion-post-process-apply-as-swipe',
  'data-recursion-post-process-apply-replace',
  'data-recursion-post-process-flow-unified',
  'data-recursion-post-process-flow-progressive',
  'data-recursion-post-process-category',
  'data-recursion-post-process-category-drag-handle',
  'data-recursion-post-process-card',
  'data-recursion-post-process-card-toggle',
  'data-recursion-post-process-card-drag-handle',
  'data-recursion-post-process-card-editor',
  'data-recursion-post-process-card-prompt',
  'data-recursion-post-process-progress'
]);
const DYNAMIC_SELECTORS = new Set([
  'data-recursion-post-process-category-drag-handle',
  'data-recursion-post-process-card-drag-handle',
  'data-recursion-post-process-card-editor',
  'data-recursion-post-process-card-prompt'
]);
const TIMEOUT_MS = Number(process.env.RECURSION_LIVE_TIMEOUT_MS || 120000);
const STARTER_DECK_ID = 'starter-post-process';
const CUSTOM_DECK_NAME = 'Playwright Post-process Deck';
const CUSTOM_CATEGORY_NAME = 'Playwright Category';
const CUSTOM_CARD_NAME = 'Playwright Card';
const CUSTOM_PROMPT = 'Preserve the source and make one concrete supported change.';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function forwardSlashes(value) {
  return String(value || '').replaceAll('\\', '/');
}

function passwordForUser(user) {
  const key = `RECURSION_SILLYTAVERN_PASSWORD_${String(user).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  return process.env[key] ?? process.env.RECURSION_SILLYTAVERN_PASSWORD ?? '';
}

function installVisualBacking() {
  const install = () => {
    const root = document.querySelector('#recursion-root');
    if (!root) return false;
    if (root.parentElement?.querySelector(':scope > [data-recursion-visual-backing]')) return true;
    const backing = document.createElement('div');
    backing.setAttribute('data-recursion-visual-backing', '');
    Object.assign(backing.style, {
      background: 'rgb(36, 36, 37)',
      inset: '0',
      pointerEvents: 'none',
      position: 'fixed',
      zIndex: '9999'
    });
    root.before(backing);
    return true;
  };
  if (install()) return;
  const observer = new MutationObserver(() => {
    if (install()) observer.disconnect();
  });
  observer.observe(document, { childList: true, subtree: true });
}

function dryRunReport() {
  return {
    schema: 'recursion.postProcessUiProof.v1',
    status: 'dry-run-pass',
    generationEnabled: false,
    viewports: VIEWPORTS.map(({ name }) => name),
    cases: VIEWPORTS.flatMap(({ name }) => STATES.map((state) => ({
      key: `${name}-${state}`,
      interaction: 'planned',
      accessibility: 'planned',
      layout: 'planned',
      visual: process.env.POST_PROCESS_UI_VISUAL_BASELINES === '1' ? 'planned' : 'disabled'
    }))),
    safetyGates: ['dedicated-user', 'authenticate', 'installed-copy', 'served-copy', 'browser-navigation'],
    artifactPolicy: {
      screenshots: true,
      traces: true,
      rawPromptText: false,
      generation: false
    },
    requiredSelectors: [...REQUIRED_SELECTORS],
    failures: []
  };
}

function findSillyTavernRoot(repositoryRoot) {
  const candidates = [
    process.env.SILLYTAVERN_ROOT,
    resolve(repositoryRoot, '..', '..', 'SillyTavern', 'SillyTavern'),
    resolve(repositoryRoot, '..', '..', '..', '..', 'SillyTavern', 'SillyTavern')
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(resolve(candidate, 'server.js')));
  check(found, 'SILLYTAVERN_ROOT is required when the default SillyTavern checkout cannot be found.');
  return resolve(found);
}

function installedCopyGate(repositoryRoot, sillyTavernRoot, user) {
  const installedRoot = resolve(sillyTavernRoot, 'data', user, 'extensions', 'Recursion');
  const publicRoot = resolve(sillyTavernRoot, 'public', 'scripts', 'extensions', 'third-party', 'Recursion');
  const result = verifyInstalledCopies({ repositoryRoot, installedRoot, publicRoot });
  check(result.ok, `Installed-copy identity gate failed with ${result.differences.length} difference(s).`);
  return { installedRoot, publicRoot, filesCompared: result.filesCompared };
}

async function servedCopyGate({ repositoryRoot, baseUrl, session }) {
  const files = productionFilePaths(repositoryRoot);
  const root = String(baseUrl).replace(/\/+$/, '');
  const mismatches = [];
  for (const relativePath of files) {
    const url = `${root}/scripts/extensions/third-party/Recursion/${forwardSlashes(relativePath)}`;
    const response = await fetch(url, { headers: session.authHeaders() });
    if (!response.ok) {
      mismatches.push({ path: relativePath, status: response.status, kind: 'unavailable' });
      continue;
    }
    const served = Buffer.from(await response.arrayBuffer());
    const expected = readFileSync(resolve(repositoryRoot, relativePath));
    if (sha256(served) !== sha256(expected)) {
      mismatches.push({ path: relativePath, status: response.status, kind: 'content-mismatch' });
    }
  }
  check(mismatches.length === 0, `Served-copy identity gate failed with ${mismatches.length} difference(s).`);
  return { status: 'match', filesCompared: files.length };
}

async function roleOrData(page, role, accessibleName, dataAttribute) {
  const byRole = page.getByRole(role, { name: accessibleName }).first();
  if (await byRole.count()) return byRole;
  return page.locator(`[${dataAttribute}]`).first();
}

async function postButton(page) {
  return roleOrData(page, 'button', /Post-process Cards/i, 'data-recursion-post-process-cards-button');
}

async function preButton(page) {
  const byRole = page.getByRole('button', { name: /Pre-process Cards/i }).first();
  if (await byRole.count()) return byRole;
  return page.locator('[data-recursion-pre-process-cards-button]').first();
}

async function openPostProcess(page, { keyboardKey = null } = {}) {
  const panel = page.locator('[data-recursion-post-process-panel]').first();
  if (await panel.isVisible()) return panel;
  const button = await postButton(page);
  if (keyboardKey) {
    await button.focus();
    await button.press(keyboardKey);
  } else {
    await button.click();
  }
  await panel.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  await page.locator('[data-recursion-post-process-deck-select]').first().waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  return panel;
}

async function closePostProcess(page) {
  const panel = page.locator('[data-recursion-post-process-panel]').first();
  if (!(await panel.isVisible())) return;
  await (await postButton(page)).click();
  await panel.waitFor({ state: 'hidden', timeout: TIMEOUT_MS });
}

async function bestEffortDisablePostProcess(page) {
  if (page.isClosed() || !(await page.locator('#recursion-root').count())) return;
  const panel = page.locator('[data-recursion-post-process-panel]').first();
  if (!(await panel.isVisible())) {
    await (await postButton(page)).click();
    await panel.waitFor({ state: 'visible', timeout: Math.min(TIMEOUT_MS, 5000) });
  }
  const enabled = page.locator('[data-recursion-post-process-enabled]').first();
  await enabled.waitFor({ state: 'visible', timeout: Math.min(TIMEOUT_MS, 5000) });
  if ((await enabled.getAttribute('aria-pressed')) === 'true') await enabled.click();
  await page.waitForFunction(() => (
    globalThis.__recursionLiveHarnessRuntime?.view?.().settings?.postProcess?.enabled === false
  ), null, { timeout: Math.min(TIMEOUT_MS, 5000) });
  await page.waitForTimeout(1200);
}

async function openPreProcess(page) {
  const panel = page.locator('[data-recursion-cards-panel]').first();
  if (await panel.isVisible()) return panel;
  await (await preButton(page)).click();
  await panel.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  return panel;
}

async function closePreProcess(page) {
  const panel = page.locator('[data-recursion-cards-panel]').first();
  if (!(await panel.isVisible())) return;
  await (await preButton(page)).click();
  await panel.waitFor({ state: 'hidden', timeout: TIMEOUT_MS });
}

async function runtimeSettings(page) {
  return page.evaluate(() => globalThis.__recursionLiveHarnessRuntime?.view?.().settings || {});
}

async function waitForPostDeck(page, expected) {
  await page.waitForFunction((value) => (
    globalThis.__recursionLiveHarnessRuntime?.view?.().settings?.postProcessDecks?.activeDeckId === value
  ), expected, { timeout: TIMEOUT_MS });
}

async function selectPostDeck(page, deckId) {
  const select = page.locator('[data-recursion-post-process-deck-select]').first();
  await select.selectOption(deckId);
  await waitForPostDeck(page, deckId);
}

async function setPressed(page, selector, expected = true) {
  const control = page.locator(selector).first();
  check(await control.count(), `Missing control: ${selector}`);
  const pressed = (await control.getAttribute('aria-pressed')) === 'true';
  if (pressed !== expected) await control.click();
  await page.waitForFunction(({ selector: query, expected: next }) => (
    document.querySelector(query)?.getAttribute('aria-pressed') === String(next)
  ), { selector, expected }, { timeout: TIMEOUT_MS });
}

async function categoryByName(page, name) {
  return page.locator('[data-recursion-post-process-category]').filter({ hasText: name }).first();
}

async function expandCategory(page, name, expanded = true) {
  const category = await categoryByName(page, name);
  const button = category.locator('[data-recursion-post-process-category-expand]').first();
  const current = (await button.getAttribute('aria-expanded')) === 'true';
  if (current !== expanded) await button.click();
  await page.waitForFunction(({ name: expectedName, expanded: expected }) => {
    const categoryNode = [...document.querySelectorAll('[data-recursion-post-process-category]')]
      .find((node) => node.textContent?.includes(expectedName));
    return categoryNode?.querySelector('[data-recursion-post-process-category-expand]')
      ?.getAttribute('aria-expanded') === String(expected);
  }, { name, expanded }, { timeout: TIMEOUT_MS });
}

async function collapseAllCategories(page) {
  const names = await page.locator('[data-recursion-post-process-category] .recursion-post-process-category-name').allTextContents();
  for (const name of names) await expandCategory(page, name.trim(), false);
}

async function fillEditor(page, { name, description = '', prompt = null }) {
  const form = page.locator('[data-recursion-post-process-card-editor]').first();
  await form.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  await form.getByLabel('Name').fill(name);
  const descriptionField = form.getByLabel('Description');
  if (await descriptionField.count()) await descriptionField.fill(description);
  if (prompt !== null) await form.getByLabel('Prompt').fill(prompt);
}

async function saveEditor(page) {
  const form = page.locator('[data-recursion-post-process-card-editor]').first();
  await form.getByRole('button', { name: 'Save' }).click();
  await form.waitFor({ state: 'detached', timeout: TIMEOUT_MS });
}

async function activePostDeck(page) {
  return page.evaluate(() => {
    const settings = globalThis.__recursionLiveHarnessRuntime?.view?.().settings?.postProcessDecks || {};
    const id = settings.activeDeckId || '';
    const deck = settings.customDecks?.[id] || null;
    return deck ? {
      id,
      name: deck.name,
      categoryOrder: [...(deck.categoryOrder || [])],
      cardOrderByCategory: Object.fromEntries(
        Object.entries(deck.cardOrderByCategory || {}).map(([categoryId, order]) => [categoryId, [...order]])
      ),
      categories: Object.values(deck.categories || {}).map(({ id: categoryId, name, enabled }) => ({ id: categoryId, name, enabled })),
      cards: Object.values(deck.cards || {}).map(({ id: cardId, categoryId, name, enabled }) => ({ id: cardId, categoryId, name, enabled }))
    } : { id, name: 'Starter Post-process Deck', categoryOrder: [], cardOrderByCategory: {}, categories: [], cards: [] };
  });
}

async function switchPreProcessDeck(page, initialId) {
  await openPreProcess(page);
  const select = page.locator('[data-recursion-card-deck-select]').first();
  const options = await select.locator('option').evaluateAll((nodes) => nodes.map((node) => node.value));
  let target = options.find((id) => id && id !== initialId);
  if (!target) {
    await page.locator('[data-recursion-card-deck-duplicate]').first().click();
    await page.waitForFunction((before) => (
      globalThis.__recursionLiveHarnessRuntime?.view?.().settings?.preProcessDecks?.activeDeckId !== before
    ), initialId, { timeout: TIMEOUT_MS });
    target = (await runtimeSettings(page)).preProcessDecks?.activeDeckId;
  } else {
    await select.selectOption(target);
    await page.waitForFunction((expected) => (
      globalThis.__recursionLiveHarnessRuntime?.view?.().settings?.preProcessDecks?.activeDeckId === expected
    ), target, { timeout: TIMEOUT_MS });
  }
  check(target && target !== initialId, 'Pre-process Deck selection did not change.');
  return target;
}

async function independentDeckProof(page) {
  await openPreProcess(page);
  const initialPreProcessId = await page.locator('[data-recursion-card-deck-select]').first().inputValue();
  await closePreProcess(page);

  await openPostProcess(page, { keyboardKey: 'Enter' });
  const focused = await page.evaluate(() => document.activeElement?.hasAttribute('data-recursion-post-process-deck-select'));
  check(focused, 'Opening Post-process Cards with Enter did not focus the deck selector.');
  await closePostProcess(page);
  await openPostProcess(page, { keyboardKey: 'Space' });
  check(
    await page.evaluate(() => document.activeElement?.hasAttribute('data-recursion-post-process-deck-select')),
    'Opening Post-process Cards with Space did not focus the deck selector.'
  );
  const defaultPostProcessEnabled = (await runtimeSettings(page)).postProcess?.enabled === true;
  check(defaultPostProcessEnabled === false, 'Post-process Cards must be Off before the proof mutates its setting.');
  await selectPostDeck(page, STARTER_DECK_ID);
  const starter = await page.evaluate(() => {
    const settings = globalThis.__recursionLiveHarnessRuntime?.view?.().settings || {};
    const deck = settings.postProcessDecks?.activeDeckId;
    return {
      enabled: settings.postProcess?.enabled === true,
      activeDeckId: deck,
      summary: document.querySelector('[data-recursion-post-process-header] .recursion-card-panel-summary')?.textContent?.trim() || '',
      editDisabled: document.querySelector('[data-recursion-post-process-deck-edit]')?.disabled === true,
      deleteDisabled: document.querySelector('[data-recursion-post-process-deck-delete]')?.disabled === true
    };
  });
  check(starter.enabled === false, 'Post-process Cards must be Off by default for the starter proof.');
  check(starter.activeDeckId === STARTER_DECK_ID, 'Starter Post-process Deck was not active.');
  check(starter.summary === 'Off', `Disabled Post-process header did not report Off: ${JSON.stringify(starter.summary)}`);
  check(starter.editDisabled && starter.deleteDisabled, 'Starter Post-process Deck did not communicate read-only structure through disabled authoring controls.');
  for (const name of ['Natural Prose', 'Follow Through']) await expandCategory(page, name, true);
  const starterRows = await page.evaluate(() => ({
    categories: [...document.querySelectorAll('[data-recursion-post-process-category] .recursion-post-process-category-name')].map((node) => node.textContent?.trim()),
    cards: [...document.querySelectorAll('[data-recursion-post-process-card] .recursion-post-process-card-name')].map((node) => node.textContent?.trim())
  }));
  check(
    JSON.stringify(starterRows.categories) === JSON.stringify(['Natural Prose', 'Follow Through']),
    `Starter categories are not in approved order: ${JSON.stringify(starterRows.categories)}`
  );
  check(JSON.stringify(starterRows.cards) === JSON.stringify([
    'Cut Echoes',
    'Natural Diction',
    'Land the Ending',
    'Act on the Threat',
    'Close the Distance',
    'Complete the Move'
  ]), `Starter cards are not the approved six cards in order: ${JSON.stringify(starterRows.cards)}`);

  await page.locator('[data-recursion-post-process-deck-duplicate]').first().click();
  await page.waitForFunction(() => (
    globalThis.__recursionLiveHarnessRuntime?.view?.().settings?.postProcessDecks?.activeDeckId !== 'starter-post-process'
  ), null, { timeout: TIMEOUT_MS });
  const duplicatedId = (await runtimeSettings(page)).postProcessDecks.activeDeckId;
  await page.locator('[data-recursion-post-process-deck-edit]').first().click();
  await fillEditor(page, { name: CUSTOM_DECK_NAME });
  await saveEditor(page);
  check((await activePostDeck(page)).name === CUSTOM_DECK_NAME, 'Duplicated Post-process Deck was not renamed.');

  await closePostProcess(page);
  const changedPreProcessId = await switchPreProcessDeck(page, initialPreProcessId);
  await closePreProcess(page);
  await openPostProcess(page);
  check(await page.locator('[data-recursion-post-process-deck-select]').first().inputValue() === duplicatedId, 'Pre-process selection changed the active Post-process Deck.');
  await selectPostDeck(page, STARTER_DECK_ID);
  await closePostProcess(page);
  await openPreProcess(page);
  check(await page.locator('[data-recursion-card-deck-select]').first().inputValue() === changedPreProcessId, 'Post-process selection changed the active Pre-process Deck.');
  await closePreProcess(page);

  await page.waitForTimeout(1000);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await page.waitForSelector('#recursion-root', { timeout: TIMEOUT_MS });
  await openPreProcess(page);
  check(await page.locator('[data-recursion-card-deck-select]').first().inputValue() === changedPreProcessId, 'Pre-process Deck selection did not persist after reload.');
  await closePreProcess(page);
  await openPostProcess(page);
  check(await page.locator('[data-recursion-post-process-deck-select]').first().inputValue() === STARTER_DECK_ID, 'Post-process Deck selection did not persist independently after reload.');
  return { initialPreProcessId, changedPreProcessId, postProcessDeckId: duplicatedId, postProcessDeckName: CUSTOM_DECK_NAME };
}

async function dragTo(page, source, target) {
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  try {
    await source.dispatchEvent('dragstart', { dataTransfer });
    await target.dispatchEvent('dragover', { dataTransfer });
    await target.dispatchEvent('drop', { dataTransfer });
    await source.dispatchEvent('dragend', { dataTransfer }).catch(() => {});
  } finally {
    await dataTransfer.dispose();
  }
}

async function selectPreProcessDeck(page, deckId) {
  const select = page.locator('[data-recursion-card-deck-select]').first();
  await select.selectOption(deckId);
  await page.waitForFunction((expected) => (
    globalThis.__recursionLiveHarnessRuntime?.view?.().settings?.preProcessDecks?.activeDeckId === expected
  ), deckId, { timeout: TIMEOUT_MS });
}

async function pointerDragTo(page, source, target) {
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  check(sourceBox && targetBox, 'Pointer drag controls could not be measured.');
  const start = {
    x: sourceBox.x + sourceBox.width / 2,
    y: sourceBox.y + sourceBox.height / 2
  };
  const end = {
    x: targetBox.x + targetBox.width / 2,
    y: targetBox.y + Math.min(12, targetBox.height / 4)
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
}

async function bodyMustNotReorder(page, movingCategoryId, targetCategoryId) {
  const before = (await activePostDeck(page)).categoryOrder;
  await dragTo(
    page,
    page.locator(`[data-recursion-post-process-category="${movingCategoryId}"] .recursion-post-process-category-copy`).first(),
    page.locator(`[data-recursion-post-process-category="${targetCategoryId}"]`).first()
  ).catch(() => {});
  const after = (await activePostDeck(page)).categoryOrder;
  check(JSON.stringify(after) === JSON.stringify(before), 'Dragging a category row body reordered the deck.');
}

async function cardBodyMustNotReorder(page, movingCardId, targetCardId) {
  const beforeDeck = await activePostDeck(page);
  const before = {
    cardOrderByCategory: beforeDeck.cardOrderByCategory,
    assignments: beforeDeck.cards
      .map(({ id, categoryId }) => [id, categoryId])
      .sort(([left], [right]) => left.localeCompare(right))
  };
  await dragTo(
    page,
    page.locator(`[data-recursion-post-process-card="${movingCardId}"] .recursion-post-process-card-copy`).first(),
    page.locator(`[data-recursion-post-process-card="${targetCardId}"]`).first()
  ).catch(() => {});
  const afterDeck = await activePostDeck(page);
  const after = {
    cardOrderByCategory: afterDeck.cardOrderByCategory,
    assignments: afterDeck.cards
      .map(({ id, categoryId }) => [id, categoryId])
      .sort(([left], [right]) => left.localeCompare(right))
  };
  check(JSON.stringify(after) === JSON.stringify(before), 'Dragging a card row body reordered the deck.');
}

async function touchDrag(page, source, target) {
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  check(sourceBox && targetBox, 'Touch drag controls could not be measured.');
  const session = await page.context().newCDPSession(page);
  const start = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 };
  const end = {
    x: targetBox.x + targetBox.width / 2,
    y: targetBox.y + Math.min(12, targetBox.height / 4)
  };
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, radiusX: 2, radiusY: 2 }] });
  await page.waitForTimeout(220);
  await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...end, radiusX: 2, radiusY: 2 }] });
  await page.waitForTimeout(40);
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function createAndExerciseCustomDeck(page, customDeckId, { compact = false } = {}) {
  await selectPostDeck(page, customDeckId);
  await page.getByRole('button', { name: 'New Category' }).click();
  await fillEditor(page, { name: CUSTOM_CATEGORY_NAME, description: 'Synthetic Playwright category.' });
  await saveEditor(page);
  let deck = await activePostDeck(page);
  const category = deck.categories.find((entry) => entry.name === CUSTOM_CATEGORY_NAME);
  check(category, 'Custom category was not created.');
  await expandCategory(page, CUSTOM_CATEGORY_NAME, true);
  await page.locator(`[data-recursion-post-process-card-create="${category.id}"]`).first().click();
  await fillEditor(page, {
    name: CUSTOM_CARD_NAME,
    description: 'Synthetic Playwright card.',
    prompt: CUSTOM_PROMPT
  });
  await saveEditor(page);
  deck = await activePostDeck(page);
  const card = deck.cards.find((entry) => entry.name === CUSTOM_CARD_NAME);
  check(card, 'Custom Post-process Card was not created.');
  const cardToggle = page.locator(`[data-recursion-post-process-card-toggle="${card.id}"]`).first();
  check((await cardToggle.getAttribute('aria-pressed')) === 'true', 'New custom card is not runnable.');
  await cardToggle.click();
  await page.waitForFunction((id) => (
    globalThis.__recursionLiveHarnessRuntime?.view?.().settings?.postProcessDecks?.customDecks?.[
      globalThis.__recursionLiveHarnessRuntime?.view?.().settings?.postProcessDecks?.activeDeckId
    ]?.cards?.[id]?.enabled === false
  ), card.id, { timeout: TIMEOUT_MS });
  await page.locator(`[data-recursion-post-process-card-toggle="${card.id}"]`).first().click();
  deck = await activePostDeck(page);
  const natural = deck.categories.find((entry) => entry.name === 'Natural Prose');
  check(natural, 'Duplicated deck is missing Natural Prose.');
  const naturalCard = deck.cards.find((entry) => entry.categoryId === natural.id);
  check(naturalCard, 'Duplicated deck is missing a Natural Prose card for body-drag proof.');
  await bodyMustNotReorder(page, category.id, natural.id);
  await expandCategory(page, CUSTOM_CATEGORY_NAME, true);
  await expandCategory(page, 'Natural Prose', true);
  await cardBodyMustNotReorder(page, card.id, naturalCard.id);
  await pointerDragTo(
    page,
    page.locator(`[data-recursion-post-process-category-drag-handle="${category.id}"]`).first(),
    page.locator(`[data-recursion-post-process-category="${natural.id}"]`).first()
  );
  await page.waitForFunction(({ moving, target }) => {
    const settings = globalThis.__recursionLiveHarnessRuntime?.view?.().settings?.postProcessDecks;
    const deckValue = settings?.customDecks?.[settings.activeDeckId];
    return deckValue?.categoryOrder?.indexOf(moving) < deckValue?.categoryOrder?.indexOf(target);
  }, { moving: category.id, target: natural.id }, { timeout: TIMEOUT_MS });

  await pointerDragTo(
    page,
    page.locator(`[data-recursion-post-process-card-drag-handle="${card.id}"]`).first(),
    page.locator(`[data-recursion-post-process-category="${natural.id}"]`).first()
  );
  await page.waitForFunction(({ cardId, categoryId }) => {
    const settings = globalThis.__recursionLiveHarnessRuntime?.view?.().settings?.postProcessDecks;
    return settings?.customDecks?.[settings.activeDeckId]?.cards?.[cardId]?.categoryId === categoryId;
  }, { cardId: card.id, categoryId: natural.id }, { timeout: TIMEOUT_MS });

  const cardHandle = page.locator(`[data-recursion-post-process-card-drag-handle="${card.id}"]`).first();
  await cardHandle.focus();
  const orderBeforeKeyboard = await page.evaluate(({ categoryId }) => {
    const settings = globalThis.__recursionLiveHarnessRuntime?.view?.().settings?.postProcessDecks;
    return settings?.customDecks?.[settings.activeDeckId]?.cardOrderByCategory?.[categoryId] || [];
  }, { categoryId: natural.id });
  check(orderBeforeKeyboard.length > 1, 'Keyboard reorder requires at least two cards in the target category.');
  const keyboardDirection = orderBeforeKeyboard.indexOf(card.id) > 0 ? 'ArrowUp' : 'ArrowDown';
  await cardHandle.press(keyboardDirection);
  const orderAfterKeyboard = await page.evaluate(({ categoryId }) => {
    const settings = globalThis.__recursionLiveHarnessRuntime?.view?.().settings?.postProcessDecks;
    return settings?.customDecks?.[settings.activeDeckId]?.cardOrderByCategory?.[categoryId] || [];
  }, { categoryId: natural.id });
  check(JSON.stringify(orderAfterKeyboard) !== JSON.stringify(orderBeforeKeyboard), 'Keyboard card reorder did not change order.');

  if (compact) {
    await collapseAllCategories(page);
    const beforeTouch = (await activePostDeck(page)).categoryOrder;
    const sourceId = beforeTouch[1];
    const targetId = beforeTouch[0];
    await touchDrag(
      page,
      page.locator(`[data-recursion-post-process-category-drag-handle="${sourceId}"]`).first(),
      page.locator(`[data-recursion-post-process-category="${targetId}"]`).first()
    );
    await page.waitForFunction((previous) => {
      const settings = globalThis.__recursionLiveHarnessRuntime?.view?.().settings?.postProcessDecks;
      return JSON.stringify(settings?.customDecks?.[settings.activeDeckId]?.categoryOrder || []) !== JSON.stringify(previous);
    }, beforeTouch, { timeout: TIMEOUT_MS });
  }

  deck = await activePostDeck(page);
  const expectedCategoryOrder = [...deck.categoryOrder];
  const expectedCardOrderByCategory = structuredClone(deck.cardOrderByCategory);
  await page.waitForTimeout(1000);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await page.waitForSelector('#recursion-root', { timeout: TIMEOUT_MS });
  await openPostProcess(page);
  deck = await activePostDeck(page);
  check(deck.id === customDeckId, 'Custom Post-process Deck selection did not persist after reorder reload.');
  const persistedSettings = await runtimeSettings(page);
  check(persistedSettings.postProcess?.applyMode === 'replace'
    && (await page.locator('[data-recursion-post-process-apply-replace]').first().getAttribute('aria-pressed')) === 'true',
  'Replace mode did not persist after reload.');
  check(persistedSettings.postProcess?.rewriteFlow === 'progressive'
    && (await page.locator('[data-recursion-post-process-flow-progressive]').first().getAttribute('aria-pressed')) === 'true',
  'Progressive flow did not persist after reload.');
  check(JSON.stringify(deck.categoryOrder) === JSON.stringify(expectedCategoryOrder), 'Category order did not persist after reload.');
  check(
    JSON.stringify(deck.cardOrderByCategory) === JSON.stringify(expectedCardOrderByCategory),
    'Card order did not persist after reload.'
  );
  check(deck.cards.find((entry) => entry.id === card.id)?.categoryId === natural.id, 'Card target category did not persist after reload.');

  await expandCategory(page, 'Natural Prose', true);
  await page.locator(`[data-recursion-post-process-card-duplicate="${card.id}"]`).first().click();
  await page.waitForFunction(({ cardId, categoryId }) => {
    const settings = globalThis.__recursionLiveHarnessRuntime?.view?.().settings?.postProcessDecks;
    const deckValue = settings?.customDecks?.[settings.activeDeckId];
    return Object.values(deckValue?.cards || {}).filter((entry) => entry.categoryId === categoryId && entry.id !== cardId && entry.name.startsWith('Playwright Card')).length > 0;
  }, { cardId: card.id, categoryId: natural.id }, { timeout: TIMEOUT_MS });
  deck = await activePostDeck(page);
  const copy = deck.cards.find((entry) => entry.id !== card.id && entry.categoryId === natural.id && entry.name.startsWith(CUSTOM_CARD_NAME));
  check(copy?.name !== CUSTOM_CARD_NAME, 'Duplicated Post-process Card did not receive a unique name.');
  await page.locator(`[data-recursion-post-process-card-delete="${copy.id}"]`).first().click();
  const cardDialog = page.getByRole('alertdialog', { name: new RegExp(`Delete ${copy.name}`) });
  await cardDialog.getByRole('button', { name: 'Delete' }).click();
  await page.waitForFunction((id) => {
    const settings = globalThis.__recursionLiveHarnessRuntime?.view?.().settings?.postProcessDecks;
    return !settings?.customDecks?.[settings.activeDeckId]?.cards?.[id];
  }, copy.id, { timeout: TIMEOUT_MS });
  return { categoryId: category.id, naturalCategoryId: natural.id, cardId: card.id };
}

async function assertAccessibility(page) {
  const post = await postButton(page);
  const focusables = await page.evaluate(() => [...document.querySelectorAll('#recursion-root button, #recursion-root select, #recursion-root input, #recursion-root textarea')]
    .filter((node) => !node.disabled && node.getClientRects().length > 0)
    .map((node) => node.getAttribute('data-recursion-post-process-cards-button') !== null));
  check(focusables.includes(true), 'Post-process toolbar button is not keyboard reachable.');
  for (const selector of [
    '[data-recursion-post-process-deck-duplicate]',
    '[data-recursion-post-process-deck-new]',
    '[data-recursion-post-process-deck-edit]',
    '[data-recursion-post-process-deck-delete]',
    '[data-recursion-post-process-category-drag-handle]',
    '[data-recursion-post-process-card-drag-handle]'
  ]) {
    const controls = page.locator(selector);
    for (let index = 0; index < await controls.count(); index += 1) {
      check(Boolean((await controls.nth(index).getAttribute('aria-label'))?.trim()), `Icon-only action lacks an accessible name: ${selector}`);
    }
  }
  const expanded = page.locator('[data-recursion-post-process-category-expand]').first();
  check(['true', 'false'].includes(await expanded.getAttribute('aria-expanded')), 'Category expander lacks aria-expanded.');
  for (const selector of [
    '[data-recursion-post-process-enabled]',
    '[data-recursion-post-process-apply-as-swipe]',
    '[data-recursion-post-process-apply-replace]',
    '[data-recursion-post-process-flow-unified]',
    '[data-recursion-post-process-flow-progressive]'
  ]) {
    check(['true', 'false'].includes(await page.locator(selector).first().getAttribute('aria-pressed')), `${selector} lacks aria-pressed.`);
  }
  await post.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  check(await post.evaluate((node) => document.activeElement === node), 'Post-process button could not be reached again with Tab.');
  const focusStyle = await post.evaluate((node) => {
    const style = getComputedStyle(node);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, boxShadow: style.boxShadow };
  });
  check((focusStyle.outlineStyle !== 'none' && focusStyle.outlineWidth !== '0px') || focusStyle.boxShadow !== 'none', 'Post-process button has no visible focus treatment.');
  const duplicateIds = await page.evaluate(() => {
    const counts = new Map();
    for (const node of document.querySelectorAll('#recursion-root [id]')) counts.set(node.id, (counts.get(node.id) || 0) + 1);
    return [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  });
  check(duplicateIds.length === 0, `Duplicate DOM ids found: ${duplicateIds.join(', ')}`);
}

async function assertLayout(page, viewport) {
  const panel = page.locator('[data-recursion-post-process-panel]').first();
  const box = await panel.boundingBox();
  check(box, 'Post-process panel has no layout box.');
  check(box.x >= -0.5, 'Post-process panel overflows left.');
  check(box.y >= -0.5, 'Post-process panel overflows top.');
  check(box.x + box.width <= viewport.width + 0.5, 'Post-process panel overflows right.');
  check(box.y + box.height <= viewport.height + 0.5, 'Post-process panel overflows bottom.');
  const layout = await page.evaluate(() => {
    const root = document.querySelector('#recursion-root');
    const panelNode = document.querySelector('[data-recursion-post-process-panel]');
    const list = panelNode?.querySelector('[data-recursion-post-process-list]');
    const header = panelNode?.querySelector('[data-recursion-post-process-header]');
    const segment = panelNode?.querySelector('[data-recursion-post-process-flow-unified]');
    const prompts = [...(panelNode?.querySelectorAll('[data-recursion-post-process-card-prompt]') || [])];
    const lastRow = panelNode?.querySelector('[data-recursion-post-process-category]:last-child');
    const rootRect = root?.getBoundingClientRect();
    const panelRect = panelNode?.getBoundingClientRect();
    const headerRect = header?.getBoundingClientRect();
    const segmentRect = segment?.getBoundingClientRect();
    return {
      documentHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      rootHorizontalOverflow: root?.scrollWidth > root?.clientWidth + 1,
      panelHorizontalOverflow: panelNode?.scrollWidth > panelNode?.clientWidth + 1,
      panelScrollTop: panelNode?.scrollTop || 0,
      listOverflowY: list ? getComputedStyle(list).overflowY : '',
      headerVisible: Boolean(
        headerRect?.width
        && headerRect?.height
        && headerRect.top >= panelRect.top
        && headerRect.bottom <= panelRect.bottom
      ),
      segmentVisible: Boolean(
        segmentRect?.width
        && segmentRect?.height
        && segmentRect.top >= panelRect.top
        && segmentRect.bottom <= panelRect.bottom
      ),
      promptOverflow: prompts.some((node) => {
        const rect = node.getBoundingClientRect();
        return rect.left < panelRect.left || rect.right > panelRect.right + 0.5;
      }),
      rootWidth: rootRect?.width || 0,
      panelWidth: panelRect?.width || 0,
      hasLastRow: Boolean(lastRow)
    };
  });
  check(!layout.documentHorizontalOverflow && !layout.rootHorizontalOverflow && !layout.panelHorizontalOverflow, 'Horizontal scrollbar appeared.');
  check(layout.panelScrollTop === 0, 'Fixed Post-process panel shell became a vertical scroll container.');
  check(layout.headerVisible && layout.segmentVisible, 'Header or segmented controls are not visible.');
  check(/auto|scroll/.test(layout.listOverflowY), 'Deck list is not the primary vertical scroll surface.');
  check(!layout.promptOverflow, 'Card prompt input exceeds panel width.');
  const list = page.locator('[data-recursion-post-process-list]').first();
  const previousListScrollTop = await list.evaluate((node) => node.scrollTop);
  const last = page.locator('[data-recursion-post-process-category]').last();
  await last.scrollIntoViewIfNeeded();
  check(await last.isVisible(), 'Final Post-process category cannot be scrolled into view.');
  await list.evaluate((node, scrollTop) => {
    node.scrollTop = scrollTop;
  }, previousListScrollTop);
}

async function measureSharedCardPanel(page, panelSelector) {
  return page.evaluate((selector) => {
    const panel = document.querySelector(selector);
    const head = panel?.querySelector('.recursion-card-panel-head');
    const deckBar = panel?.querySelector('.recursion-card-panel-deck-bar');
    const deckSelector = panel?.querySelector('.recursion-card-panel-deck-selector');
    const list = panel?.querySelector('.recursion-card-panel-list');
    const category = panel?.querySelector('.recursion-card-panel-category');
    const categoryHead = category?.querySelector('.recursion-card-panel-category-head');
    const disclosure = category?.querySelector('.recursion-card-panel-disclosure');
    const card = category?.querySelector('.recursion-card-panel-card');
    const cardMain = card?.querySelector('.recursion-card-panel-card-main');
    const state = card?.querySelector('.recursion-card-panel-state-marker');
    const rect = (node) => {
      const box = node?.getBoundingClientRect();
      return box ? { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right } : null;
    };
    const cardRect = card?.getBoundingClientRect();
    const categoryHeadRect = categoryHead?.getBoundingClientRect();
    const disclosureRect = disclosure?.getBoundingClientRect();
    const stateRect = state?.getBoundingClientRect();
    return {
      panel: rect(panel),
      head: rect(head),
      deckBar: rect(deckBar),
      deckSelector: rect(deckSelector),
      list: rect(list),
      category: rect(category),
      categoryHead: rect(categoryHead),
      disclosure: rect(disclosure),
      card: rect(card),
      cardMain: rect(cardMain),
      state: rect(state),
      disclosureInset: categoryHeadRect && disclosureRect ? disclosureRect.x - categoryHeadRect.x : null,
      stateRightInset: cardRect && stateRect ? cardRect.right - stateRect.right : null,
      actionRailCount: card?.querySelectorAll(':scope > .recursion-card-panel-row-actions').length ?? -1,
      listOverflowY: list ? getComputedStyle(list).overflowY : '',
      listScrollbarGutter: list ? getComputedStyle(list).scrollbarGutter : '',
      shared: {
        panel: panel?.classList.contains('recursion-card-panel') === true,
        head: Boolean(head),
        deckBar: Boolean(deckBar),
        deckSelector: Boolean(deckSelector),
        list: Boolean(list),
        category: Boolean(category),
        categoryHead: Boolean(categoryHead),
        disclosure: Boolean(disclosure),
        card: Boolean(card),
        cardMain: Boolean(cardMain),
        state: Boolean(state)
      }
    };
  }, panelSelector);
}

async function assertSharedPanelGeometry(page, viewport) {
  await closePostProcess(page).catch(() => {});
  await openPreProcess(page);
  await selectPreProcessDeck(page, DEFAULT_PRE_PROCESS_DECK_ID);
  const preCategory = page.locator('[data-recursion-card-category-toggle]').first();
  if (await preCategory.getAttribute('aria-expanded') !== 'true') await preCategory.click();
  const pre = await measureSharedCardPanel(page, '[data-recursion-cards-panel]');
  await closePreProcess(page);

  await openPostProcess(page);
  await selectPostDeck(page, STARTER_DECK_ID);
  await collapseAllCategories(page);
  await expandCategory(page, 'Natural Prose', true);
  const post = await measureSharedCardPanel(page, '[data-recursion-post-process-panel]');

  for (const [phase, measurement] of [['Pre-process', pre], ['Post-process', post]]) {
    check(Object.values(measurement.shared).every(Boolean), `${phase} panel did not render the complete shared Card Deck structure.`);
  }
  const closeEnough = (left, right, tolerance = 1.5) => Math.abs(Number(left) - Number(right)) <= tolerance;
  for (const key of ['panel', 'deckBar', 'deckSelector', 'list', 'category', 'categoryHead', 'card', 'cardMain']) {
    check(closeEnough(pre[key].x, post[key].x), `${key} left edge differs between Pre-process and Post-process.`);
    check(
      closeEnough(pre[key].width, post[key].width),
      `${key} width differs between Pre-process and Post-process: pre=${pre[key].width}, post=${post[key].width}.`
    );
  }
  check(closeEnough(pre.deckBar.height, post.deckBar.height), 'Deck toolbar height differs between Pre-process and Post-process.');
  check(closeEnough(pre.disclosureInset, post.disclosureInset), 'Category disclosure inset differs between Pre-process and Post-process.');
  check(closeEnough(pre.stateRightInset, post.stateRightInset), 'Card eye right margin differs between Pre-process and Post-process.');
  check(pre.actionRailCount === 0 && post.actionRailCount === 0, 'Read-only Card rows rendered an empty action rail.');
  check(
    [pre.listOverflowY, post.listOverflowY].every((value) => /auto|scroll/.test(value)),
    'A shared Card list is not the primary scroll surface.'
  );
  check(
    [pre.listScrollbarGutter, post.listScrollbarGutter].every((value) => value.includes('stable')),
    'A shared Card list does not reserve a stable scrollbar gutter.'
  );
  if (viewport.name !== 'compact') {
    check(closeEnough(pre.head.height, post.head.height), 'Header height differs between Pre-process and Post-process.');
  }
}

function completeRecursionSurface(page) {
  const root = page.locator('#recursion-root');
  const bar = page.locator('.recursion-bar').first();
  return {
    locator(selector) {
      return root.locator(selector);
    },
    async screenshot(options = {}) {
      const barBox = await bar.boundingBox();
      const panel = page.locator('[data-recursion-post-process-panel]').first();
      const panelBox = await panel.isVisible() ? await panel.boundingBox() : null;
      check(barBox, 'Recursion bar has no visual box.');
      const boxes = [barBox, panelBox].filter(Boolean);
      const left = Math.min(...boxes.map((box) => box.x));
      const top = Math.min(...boxes.map((box) => box.y));
      const right = Math.max(...boxes.map((box) => box.x + box.width));
      const bottom = Math.max(...boxes.map((box) => box.y + box.height));
      return page.screenshot({
        ...options,
        clip: {
          x: Math.max(0, left),
          y: Math.max(0, top),
          width: right - Math.max(0, left),
          height: bottom - Math.max(0, top)
        }
      });
    }
  };
}

async function captureCase({ page, report, viewport, state, artifactDir }) {
  await assertAccessibility(page);
  await assertLayout(page, viewport);
  const root = completeRecursionSurface(page);
  const artifactPath = resolve(artifactDir, viewport.name, `${state}.png`);
  mkdirSync(resolve(artifactDir, viewport.name), { recursive: true });
  const actual = await root.screenshot({
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
    mask: [root.locator('[data-recursion-visual-volatile]')]
  });
  writeFileSync(artifactPath, actual);
  const baselinePath = resolve('tests', 'visual-baselines', 'post-process-cards', viewport.name, `${state}.png`);
  let visual = 'disabled';
  let actualSha256 = sha256(actual);
  let expectedSha256 = null;
  if (process.env.POST_PROCESS_UI_VISUAL_BASELINES === '1') {
    if (process.env.UPDATE_VISUAL_BASELINES === '1') {
      mkdirSync(resolve('tests', 'visual-baselines', 'post-process-cards', viewport.name), { recursive: true });
      writeFileSync(baselinePath, actual);
      const compared = assertVisualBaselineBuffer(actual, baselinePath);
      visual = 'updated-candidate';
      actualSha256 = compared.actualSha256;
      expectedSha256 = compared.expectedSha256;
    } else {
      const compared = assertVisualBaselineBuffer(actual, baselinePath);
      visual = compared.baseline;
      actualSha256 = compared.actualSha256;
      expectedSha256 = compared.expectedSha256;
    }
  }
  check(sha256(readFileSync(artifactPath)) === actualSha256, 'Retained visual artifact hash does not match compared bytes.');
  report.cases.push({
    key: `${viewport.name}-${state}`,
    interaction: 'pass',
    accessibility: 'pass',
    layout: 'pass',
    visual,
    baselinePath: forwardSlashes(relative(process.cwd(), baselinePath)),
    sha256: actualSha256,
    actualSha256,
    expectedSha256
  });
}

async function setStarterState(page, { enabled, applyMode, rewriteFlow, expanded }) {
  await selectPostDeck(page, STARTER_DECK_ID);
  await setPressed(page, '[data-recursion-post-process-enabled]', enabled);
  await setPressed(page, applyMode === 'replace'
    ? '[data-recursion-post-process-apply-replace]'
    : '[data-recursion-post-process-apply-as-swipe]');
  await setPressed(page, rewriteFlow === 'progressive'
    ? '[data-recursion-post-process-flow-progressive]'
    : '[data-recursion-post-process-flow-unified]');
  await collapseAllCategories(page);
  for (const name of expanded) await expandCategory(page, name, true);
}

async function runViewport(page, report, viewport, artifactDir) {
  await bestEffortDisablePostProcess(page);
  const selection = await independentDeckProof(page);
  await assertSharedPanelGeometry(page, viewport);
  await openPostProcess(page);
  await setStarterState(page, { enabled: false, applyMode: 'as-swipe', rewriteFlow: 'unified', expanded: [] });
  await captureCase({ page, report, viewport, state: 'starter-off', artifactDir });
  await setStarterState(page, { enabled: true, applyMode: 'as-swipe', rewriteFlow: 'unified', expanded: ['Natural Prose'] });
  await captureCase({ page, report, viewport, state: 'starter-unified', artifactDir });
  await setStarterState(page, { enabled: true, applyMode: 'replace', rewriteFlow: 'progressive', expanded: ['Natural Prose', 'Follow Through'] });
  await captureCase({ page, report, viewport, state: 'starter-progressive', artifactDir });

  const custom = await createAndExerciseCustomDeck(page, selection.postProcessDeckId, { compact: viewport.name === 'compact' });
  await expandCategory(page, 'Natural Prose', true);
  await captureCase({ page, report, viewport, state: 'custom-deck', artifactDir });

  await page.locator(`[data-recursion-post-process-card-edit="${custom.cardId}"]`).first().click();
  await captureCase({ page, report, viewport, state: 'card-editor', artifactDir });
  await page.getByRole('button', { name: 'Cancel' }).last().click();

  await page.locator('[data-recursion-post-process-deck-delete]').first().click();
  const deckDeleteInput = page.locator('[data-recursion-post-process-deck-delete-text]').first();
  await deckDeleteInput.fill('delete');
  await captureCase({ page, report, viewport, state: 'delete-confirm', artifactDir });
  await page.locator('[data-recursion-post-process-deck-delete-cancel]').first().click();

  await setPressed(page, '[data-recursion-post-process-enabled]', false);
  await page.locator('[data-recursion-post-process-deck-delete]').first().click();
  await page.locator('[data-recursion-post-process-deck-delete-text]').first().fill('delete');
  await page.locator('[data-recursion-post-process-deck-delete-confirm]').first().click();
  await waitForPostDeck(page, STARTER_DECK_ID);

  await page.locator('[data-recursion-post-process-deck-select]').first().press('Escape');
  const panel = page.locator('[data-recursion-post-process-panel]').first();
  await panel.waitFor({ state: 'hidden', timeout: TIMEOUT_MS });
  const post = await postButton(page);
  check(await post.evaluate((node) => document.activeElement === node), 'Escape did not return focus to the Post-process button.');
  return selection;
}

async function reducedMotionProof(browser, baseUrl, cookies) {
  const context = await browser.newContext({
    viewport: { width: 1360, height: 820 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce'
  });
  await context.addCookies(cookies);
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await page.waitForSelector('#recursion-root', { timeout: TIMEOUT_MS });
  const running = await page.evaluate(() => [...document.querySelectorAll('#recursion-root *')]
    .filter((node) => {
      const style = getComputedStyle(node);
      return style.animationName !== 'none' && style.animationPlayState === 'running';
    })
    .map((node) => node.className)
    .slice(0, 10));
  await context.close();
  check(running.length === 0, `Reduced-motion Recursion controls still animate: ${running.join(', ')}`);
}

function writeArtifacts(report, artifactDir) {
  writeFileSync(resolve(artifactDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const summary = [
    '# Post-process Cards UI proof',
    '',
    `- Status: ${report.status}`,
    `- Installed copy: ${report.installedCopy.status}`,
    `- Viewports: ${report.viewports.join(', ')}`,
    `- Cases: ${report.cases.length}`,
    `- Generation calls observed: ${report.generationRequestCount}`,
    `- Visual baselines: ${process.env.POST_PROCESS_UI_VISUAL_BASELINES === '1' ? 'enabled' : 'disabled'}`
  ].join('\n');
  writeFileSync(resolve(artifactDir, 'summary.md'), `${summary}\n`);
}

async function main() {
  if (process.argv.includes('--dry-run')) return dryRunReport();

  const userCheck = validateSoakUserHandle(process.env.RECURSION_SILLYTAVERN_USER || '');
  check(userCheck.ok, `Unsafe user: ${userCheck.reason || 'RECURSION_SILLYTAVERN_USER is required'}`);
  const user = userCheck.user;
  const baseUrl = process.env.SILLYTAVERN_BASE_URL || '';
  check(baseUrl, 'SILLYTAVERN_BASE_URL is required.');
  const repositoryRoot = process.cwd();
  const sillyTavernRoot = findSillyTavernRoot(repositoryRoot);
  const runId = createRunId('post-process-ui');
  const artifactDir = resolve(process.env.RECURSION_ARTIFACT_DIR || 'artifacts', 'post-process-ui', runId);
  mkdirSync(artifactDir, { recursive: true });
  const report = {
    schema: 'recursion.postProcessUiProof.v1',
    status: 'pass',
    installedCopy: { status: 'pending', commitSha: '' },
    viewports: VIEWPORTS.map(({ name }) => name),
    cases: [],
    generationRequestCount: 0,
    selections: [],
    failures: []
  };

  let browser;
  try {
    const session = createSillyTavernHttpSession({
      baseUrl,
      user,
      password: passwordForUser(user)
    });
    await session.init();
    await session.login();
    const installed = installedCopyGate(repositoryRoot, sillyTavernRoot, user);
    const served = await servedCopyGate({ repositoryRoot, baseUrl, session });
    report.installedCopy = {
      status: 'match',
      commitSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim(),
      filesCompared: installed.filesCompared,
      servedFilesCompared: served.filesCompared
    };

    browser = await chromium.launch({
      headless: process.env.RECURSION_SILLYTAVERN_HEADLESS !== '0'
    });
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        hasTouch: viewport.hasTouch,
        isMobile: viewport.hasTouch
      });
      const tracePath = resolve(artifactDir, viewport.name, 'trace.zip');
      mkdirSync(resolve(artifactDir, viewport.name), { recursive: true });
      const viewportResult = await runWithRetainedTrace(context, tracePath, async () => {
        await context.addCookies(session.playwrightCookies());
        await context.addInitScript(() => { globalThis.__recursionLiveHarness = true; });
        await context.addInitScript(installVisualBacking);
        const page = await context.newPage();
        try {
          const browserErrors = [];
          let generationRequests = 0;
          page.on('pageerror', (error) => browserErrors.push(`pageerror:${String(error?.message || error).slice(0, 240)}`));
          page.on('console', (message) => {
            if (message.type() === 'error') browserErrors.push(`console:${message.text().slice(0, 240)}`);
          });
          page.on('request', (request) => {
            if (request.method() === 'POST' && [
              '/api/backends/chat-completions/generate',
              '/api/backends/text-completions/generate'
            ].some((endpoint) => request.url().includes(endpoint))) generationRequests += 1;
          });
          await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
          await page.waitForSelector('#recursion-root', { timeout: TIMEOUT_MS });
          const staticSelectors = REQUIRED_SELECTORS.filter((attribute) => !DYNAMIC_SELECTORS.has(attribute));
          const missing = await page.evaluate((attributes) => attributes.filter((attribute) => !document.querySelector(`[${attribute}]`)), staticSelectors);
          check(missing.length === 0, `Missing required Post-process controls: ${missing.join(', ')}`);
          const selection = await runViewport(page, report, viewport, artifactDir);
          check(generationRequests === 0, `${viewport.name} UI proof sent ${generationRequests} generation request(s).`);
          check(browserErrors.length === 0, `${viewport.name} browser errors: ${browserErrors.join(' | ')}`);
          return { selection, generationRequests };
        } finally {
          await bestEffortDisablePostProcess(page).catch(() => {});
        }
      });
      report.selections.push({
        viewport: viewport.name,
        preProcessDeckId: viewportResult.selection.changedPreProcessId,
        postProcessDeckId: viewportResult.selection.postProcessDeckId,
        postProcessDeckName: viewportResult.selection.postProcessDeckName
      });
      report.generationRequestCount += viewportResult.generationRequests;
    }
    await reducedMotionProof(browser, baseUrl, session.playwrightCookies());
    check(report.cases.length === VIEWPORTS.length * STATES.length, 'UI proof did not capture every required case.');
  } catch (error) {
    report.status = /Unsafe user/.test(String(error?.message || error)) ? 'unsafe-user'
      : /Installed-copy|Served-copy/.test(String(error?.message || error)) ? 'stale-extension'
      : 'ui-fail';
    report.failures.push({
      message: String(error?.message || error).slice(0, 500),
      stack: String(error?.stack || '').split('\n').slice(0, 8)
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  writeArtifacts(report, artifactDir);
  return report;
}

const report = await main();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!['pass', 'dry-run-pass'].includes(report.status)) process.exitCode = 1;
