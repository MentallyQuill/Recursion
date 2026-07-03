import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import {
  createRunId,
  createSillyTavernHttpSession,
  validateSoakUserHandle
} from './lib/sillytavern-live-harness.mjs';

const DEFAULT_TIMEOUT_MS = 120000;

const RETENTION_SELECTORS = Object.freeze({
  sourceWindowMessages: '[data-recursion-setting-source-window-messages]',
  sourceWindowCharacters: '[data-recursion-setting-source-window-characters]',
  providerVisibleMessages: '[data-recursion-setting-provider-visible-messages]',
  sceneCachesPerChat: '[data-recursion-setting-scene-caches-per-chat]',
  sceneCachesTotal: '[data-recursion-setting-scene-caches-total]',
  sourceVariantsPerScene: '[data-recursion-setting-source-variants-per-scene]',
  runJournalEntries: '[data-recursion-setting-run-journal-entries]'
});

let activePhase = 'startup';

function phase(name) {
  activePhase = name;
}

function fail(result, message, details = {}) {
  const error = new Error(message);
  error.result = result;
  error.details = details;
  throw error;
}

function passwordEnvKey(user) {
  return `RECURSION_SILLYTAVERN_PASSWORD_${String(user).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function passwordForUser(user, env) {
  return env[passwordEnvKey(user)] ?? env.RECURSION_SILLYTAVERN_PASSWORD ?? '';
}

function assertPreflight(argv, env) {
  if (!argv.includes('--live')) fail('dry-run', 'Pass --live to mutate a dedicated SillyTavern user.');
  if (!env.SILLYTAVERN_BASE_URL) fail('missing-base-url', 'SILLYTAVERN_BASE_URL is required.');
  const userResult = validateSoakUserHandle(env.RECURSION_SILLYTAVERN_USER);
  if (!userResult.ok) {
    fail('unsafe-user', 'RECURSION_SILLYTAVERN_USER must be a dedicated recursion-soak-* user.', userResult);
  }
  return userResult.user;
}

async function waitForRecursion(page, timeoutMs) {
  await page.waitForSelector('#recursion-root', { timeout: timeoutMs });
  await page.waitForSelector('[data-recursion-actions]', { timeout: timeoutMs });
  await page.waitForFunction(() => typeof globalThis.__recursionLiveHarnessRuntime?.view === 'function', null, { timeout: timeoutMs });
}

async function openRetentionSettings(page, timeoutMs) {
  await page.locator('[data-recursion-actions]').first().click({ timeout: timeoutMs });
  await page.waitForFunction(() => document.querySelector('[data-recursion-settings-panel]')?.hidden === false, null, { timeout: timeoutMs });
  await page.locator('[data-recursion-settings-tab-advanced]').first().click({ timeout: timeoutMs });
  await page.waitForFunction(() => {
    const pane = document.querySelector('[data-recursion-settings-advanced]');
    return pane?.hidden === false && Boolean(document.querySelector('[data-recursion-setting-source-window-messages]'));
  }, null, { timeout: timeoutMs });
}

async function fillRetentionSettings(page, values, timeoutMs) {
  for (const [key, value] of Object.entries(values)) {
    const selector = RETENTION_SELECTORS[key];
    if (!selector) continue;
    phase(`fill-${key}`);
    const control = page.locator(selector).first();
    await control.fill(String(value), { timeout: timeoutMs });
    await control.dispatchEvent('change');
  }
  phase('wait-runtime-retention');
  try {
    await page.waitForFunction((expected) => {
      const viewRetention = globalThis.__recursionLiveHarnessRuntime?.view?.()?.settings?.retention || {};
      return Object.entries(expected).every(([key, value]) => Number(viewRetention[key]) === Number(value));
    }, values, { timeout: timeoutMs });
  } catch (error) {
    const state = await page.evaluate(retentionStateScript()).catch(() => null);
    fail('retention-settings-runtime-timeout', 'Runtime retention settings did not match UI edits.', {
      expected: values,
      state,
      error: error?.message || String(error)
    });
  }
}

function retentionStateScript() {
  return () => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const settingsRoot = context.extensionSettings || globalThis.extension_settings || {};
    const inputs = Object.fromEntries(Object.entries({
      sourceWindowMessages: '[data-recursion-setting-source-window-messages]',
      sourceWindowCharacters: '[data-recursion-setting-source-window-characters]',
      providerVisibleMessages: '[data-recursion-setting-provider-visible-messages]',
      sceneCachesPerChat: '[data-recursion-setting-scene-caches-per-chat]',
      sceneCachesTotal: '[data-recursion-setting-scene-caches-total]',
      sourceVariantsPerScene: '[data-recursion-setting-source-variants-per-scene]',
      runJournalEntries: '[data-recursion-setting-run-journal-entries]'
    }).map(([key, selector]) => [key, Number(document.querySelector(selector)?.value)]));
    return {
      inputs,
      runtimeRetention: globalThis.__recursionLiveHarnessRuntime?.view?.()?.settings?.retention || null,
      persistedRetention: settingsRoot.recursion?.retention || null
    };
  };
}

async function assertRetentionState(page, expected, timeoutMs) {
  phase('wait-persisted-retention');
  try {
    await page.waitForFunction((target) => {
      const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
      const settingsRoot = context.extensionSettings || globalThis.extension_settings || {};
      const runtimeRetention = globalThis.__recursionLiveHarnessRuntime?.view?.()?.settings?.retention || {};
      const persistedRetention = settingsRoot.recursion?.retention || {};
      return Object.entries(target).every(([key, value]) => (
        Number(runtimeRetention[key]) === Number(value)
        && Number(persistedRetention[key]) === Number(value)
        && Number(document.querySelector(`[data-recursion-setting-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}]`)?.value) === Number(value)
      ));
    }, expected, { timeout: timeoutMs });
  } catch (error) {
    const state = await page.evaluate(retentionStateScript()).catch(() => null);
    fail('retention-settings-persist-timeout', 'Persisted retention settings did not match UI edits.', {
      expected,
      state,
      error: error?.message || String(error)
    });
  }
  return page.evaluate(retentionStateScript());
}

async function seedChat(page, { runId, count, textSize }, timeoutMs) {
  await page.evaluate(({ marker, count: messageCount, textSize: size }) => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const payload = 'R'.repeat(size);
    const messages = [];
    for (let index = 0; index < messageCount; index += 1) {
      messages.push({
        mesid: index,
        is_user: index % 2 === 1,
        name: index % 2 === 1 ? 'Recursion Retention User' : 'Recursion Retention Assistant',
        mes: `${marker} retention-proof-message-${index} ${payload}`
      });
    }
    if (!Array.isArray(context.chat)) context.chat = [];
    context.chat.splice(0, context.chat.length, ...messages);
    if (Array.isArray(globalThis.chat) && globalThis.chat !== context.chat) {
      globalThis.chat.splice(0, globalThis.chat.length, ...messages);
    } else {
      globalThis.chat = context.chat;
    }
    globalThis.__recursionRetentionProofChat = { marker, messages };
  }, { marker: runId, count, textSize });
  await page.waitForFunction(({ expectedCount, marker }) => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    return Array.isArray(context.chat)
      && context.chat.length === expectedCount
      && context.chat.every((message) => String(message?.mes || '').includes(marker));
  }, { expectedCount: count, marker: runId }, { timeout: timeoutMs });
}

async function readServedHostSnapshot(page) {
  return page.evaluate(async () => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const { createSillyTavernHost } = await import('/scripts/extensions/third-party/Recursion/src/hosts/sillytavern/host.mjs');
    const host = createSillyTavernHost({
      contextFactory: () => context,
      fetchImpl: globalThis.fetch
    });
    return host.snapshot();
  });
}

function compactSnapshot(snapshot) {
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  return {
    sourceWindowMessageCount: snapshot?.sourceWindowMessageCount ?? messages.length,
    sourceWindowCharacterCount: snapshot?.sourceWindowCharacterCount ?? null,
    sourceWindowTruncated: snapshot?.sourceWindowTruncated === true,
    sourceWindowLimitReason: snapshot?.sourceWindowLimitReason || '',
    firstMesId: snapshot?.sourceWindowFirstMesId ?? messages[0]?.mesId ?? null,
    lastMesId: snapshot?.sourceWindowLastMesId ?? messages.at(-1)?.mesId ?? null,
    latestMesId: snapshot?.latestMesId ?? null,
    messageMesIds: messages.map((message) => message.mesId)
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const env = process.env;
  phase('preflight');
  const user = assertPreflight(argv, env);
  const timeoutMs = Number(env.RECURSION_LIVE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const runId = createRunId('retention-caps-proof');
  const artifactDir = resolve('artifacts', 'live-retention-caps', runId);
  mkdirSync(artifactDir, { recursive: true });

  phase('http-session');
  const session = createSillyTavernHttpSession({
    baseUrl: env.SILLYTAVERN_BASE_URL,
    user,
    password: passwordForUser(user, env)
  });
  await session.init();
  await session.login();

  phase('launch-browser');
  const browser = await chromium.launch({ headless: env.RECURSION_SILLYTAVERN_HEADLESS !== '0' });
  try {
    const context = await browser.newContext({ viewport: { width: 1360, height: 860 } });
    await context.addCookies(session.playwrightCookies());
    await context.addInitScript(() => {
      globalThis.__recursionLiveHarness = true;
    });
    const page = await context.newPage();
    phase('navigate');
    await page.goto(env.SILLYTAVERN_BASE_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    phase('wait-recursion');
    await waitForRecursion(page, timeoutMs);
    phase('open-retention-settings');
    await openRetentionSettings(page, timeoutMs);

    const messageCapRetention = {
      sourceWindowMessages: 12,
      sourceWindowCharacters: 6000,
      providerVisibleMessages: 4,
      sceneCachesPerChat: 1,
      sceneCachesTotal: 4,
      sourceVariantsPerScene: 1,
      runJournalEntries: 10
    };
    phase('apply-message-cap-settings');
    await fillRetentionSettings(page, messageCapRetention, timeoutMs);
    const messageCapState = await assertRetentionState(page, messageCapRetention, timeoutMs);
    const settingsScreenshot = resolve(artifactDir, '01-retention-settings.png');
    phase('screenshot-settings');
    await page.locator('[data-recursion-settings-panel]').first().screenshot({ path: settingsScreenshot, timeout: timeoutMs });

    phase('seed-message-cap-chat');
    await seedChat(page, { runId, count: 20, textSize: 40 }, timeoutMs);
    phase('snapshot-message-cap');
    const messageCapSnapshot = await readServedHostSnapshot(page);
    const messageCap = compactSnapshot(messageCapSnapshot);
    if (messageCap.sourceWindowMessageCount !== 12 || messageCap.firstMesId !== 8 || messageCap.lastMesId !== 19) {
      fail('source-message-cap-failed', 'Source Messages cap did not retain only the 12 newest visible messages.', { messageCap });
    }
    if (!messageCap.sourceWindowTruncated || messageCap.sourceWindowLimitReason !== 'message-cap') {
      fail('source-message-cap-reason-failed', 'Source Messages cap did not report message-cap truncation.', { messageCap });
    }

    const characterCapRetention = {
      ...messageCapRetention,
      sourceWindowMessages: 200,
      sourceWindowCharacters: 6000
    };
    phase('apply-character-cap-settings');
    await fillRetentionSettings(page, characterCapRetention, timeoutMs);
    const characterCapState = await assertRetentionState(page, characterCapRetention, timeoutMs);
    phase('seed-character-cap-chat');
    await seedChat(page, { runId: `${runId}-char`, count: 10, textSize: 1000 }, timeoutMs);
    phase('snapshot-character-cap');
    const characterCapSnapshot = await readServedHostSnapshot(page);
    const characterCap = compactSnapshot(characterCapSnapshot);
    if (!characterCap.sourceWindowTruncated || characterCap.sourceWindowLimitReason !== 'character-budget') {
      fail('source-character-cap-reason-failed', 'Source Text Budget cap did not report character-budget truncation.', { characterCap });
    }
    if (characterCap.sourceWindowCharacterCount > characterCapRetention.sourceWindowCharacters || characterCap.sourceWindowMessageCount >= 10) {
      fail('source-character-cap-failed', 'Source Text Budget cap did not bound the source window.', { characterCap });
    }

    console.log(JSON.stringify({
      status: 'pass',
      result: 'live-retention-caps-pass',
      user,
      runId,
      settings: {
        messageCapState,
        characterCapState
      },
      sourceMessageCap: messageCap,
      sourceCharacterCap: characterCap,
      screenshots: {
        settings: settingsScreenshot
      }
    }, null, 2));
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: 'fail',
    result: error.result || 'live-retention-caps-error',
    phase: activePhase,
    error: error.message,
    details: error.details || null
  }, null, 2));
  process.exit(1);
});
