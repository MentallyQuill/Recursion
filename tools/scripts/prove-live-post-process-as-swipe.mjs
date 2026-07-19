import { chromium } from 'playwright';
import {
  createSillyTavernHttpSession,
  validateSoakUserHandle
} from './lib/sillytavern-live-harness.mjs';
import { runInstalledCopyVerifierCli } from './verify-installed-copy.mjs';

const DEFAULT_TIMEOUT_MS = 240000;

function fail(result, message, details = {}) {
  const error = new Error(message);
  error.result = result;
  error.details = details;
  throw error;
}

function passwordForUser(user, env) {
  const key = `RECURSION_SILLYTAVERN_PASSWORD_${String(user).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  return env[key] ?? env.RECURSION_SILLYTAVERN_PASSWORD ?? '';
}

function preflight(argv, env) {
  if (!argv.includes('--live')) fail('dry-run', 'Pass --live to mutate a dedicated SillyTavern user.');
  if (!env.SILLYTAVERN_BASE_URL) fail('missing-base-url', 'SILLYTAVERN_BASE_URL is required.');
  const user = validateSoakUserHandle(env.RECURSION_SILLYTAVERN_USER);
  if (!user.ok) fail('unsafe-user', 'RECURSION_SILLYTAVERN_USER must be a dedicated recursion-soak-* user.', user);
  return user.user;
}

async function selectTargetChat(page, { characterName = '', chatFile = '', timeoutMs }) {
  await page.waitForFunction(() => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.();
    return Array.isArray(context?.characters) && context.characters.length > 0;
  }, null, { timeout: timeoutMs });
  const selected = await page.evaluate(async ({ requestedCharacter, requestedChatFile }) => {
    const readContext = () => globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.();
    let context = readContext();
    const characters = Array.isArray(context?.characters) ? context.characters : [];
    let characterIndex = requestedCharacter
      ? characters.findIndex((entry) => {
          const expected = requestedCharacter.toLowerCase();
          const name = String(entry?.name || '').trim().toLowerCase();
          const avatar = String(entry?.avatar || '').trim().toLowerCase().replace(/\.png$/i, '');
          return name === expected || avatar === expected;
        })
      : Number(context?.characterId);
    if (!Number.isInteger(characterIndex) || characterIndex < 0 || characterIndex >= characters.length) {
      if (requestedCharacter) return { ok: false, reason: 'requested-character-unavailable' };
      characterIndex = 0;
    }
    if (Number(context.characterId) !== characterIndex) {
      if (typeof context.selectCharacterById !== 'function') return { ok: false, reason: 'select-character-unavailable' };
      await context.selectCharacterById(characterIndex);
      context = readContext() || context;
    }
    const character = context.characters?.[characterIndex] || characters[characterIndex];
    const selectedChatFile = String(
      requestedChatFile || character?.chat || context.chatId || context.currentChatId || ''
    ).replace(/\.jsonl$/i, '');
    if (!selectedChatFile || typeof context.openCharacterChat !== 'function') {
      return { ok: false, reason: 'chat-reload-unavailable' };
    }
    await context.openCharacterChat(selectedChatFile);
    return {
      ok: true,
      characterName: String(character?.name || ''),
      chatFile: selectedChatFile
    };
  }, {
    requestedCharacter: String(characterName || '').trim(),
    requestedChatFile: String(chatFile || '').trim()
  });
  if (!selected?.ok) fail('target-chat-unavailable', 'A reloadable dedicated-user character chat is required.', selected);
  return selected;
}

async function assistantState(page, messageId = null) {
  return page.evaluate(async (expectedMessageId) => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const chat = Array.isArray(context.chat) ? context.chat : [];
    const index = expectedMessageId === null
      ? chat.findLastIndex((entry) => entry?.is_user === false)
      : chat.findIndex((entry, row) => Number(entry?.mesid ?? row) === Number(expectedMessageId));
    const assistant = index >= 0 ? chat[index] : null;
    const swipeId = Number(assistant?.swipe_id ?? assistant?.swipeId ?? 0);
    const swipes = Array.isArray(assistant?.swipes) ? assistant.swipes : [];
    const swipeInfo = Array.isArray(assistant?.swipe_info) ? assistant.swipe_info : [];
    const marker = swipeInfo[swipeId]?.extra?.recursion?.postProcess || null;
    const { hashJson } = await import('/scripts/extensions/third-party/Recursion/src/core.mjs');
    const selectedTextHash = hashJson(String(swipes[swipeId] ?? ''));
    const previousTextHash = swipeId > 0 ? hashJson(String(swipes[swipeId - 1] ?? '')) : '';
    return {
      messageId: Number(assistant?.mesid ?? index),
      index,
      swipeId,
      swipeCount: swipes.length,
      swipeInfoLength: swipeInfo.length,
      markerSchema: String(marker?.schema || ''),
      markerSourceHash: String(marker?.sourceHash || ''),
      markerCandidateHash: String(marker?.candidateHash || ''),
      selectedTextHash,
      previousTextHash,
      markerValid: marker?.schema === 'recursion.postProcessMarker.v1'
        && marker.sourceHash === previousTextHash
        && marker.candidateHash === selectedTextHash,
      postProcessPending: globalThis.__recursionLiveHarnessRuntime?.postProcessPending?.() === true,
      postProcessRunning: globalThis.__recursionLiveHarnessRuntime?.postProcessRunning?.() === true,
      hostGenerationActive: globalThis.__recursionLiveHarnessRuntime?.view?.()?.hostGenerationActive === true,
      nativeStopVisible: (() => {
        const stop = document.querySelector('#mes_stop');
        return Boolean(stop && getComputedStyle(stop).display !== 'none' && stop.getClientRects().length > 0);
      })()
    };
  }, messageId);
}

async function main() {
  const argv = process.argv.slice(2);
  const env = process.env;
  const user = preflight(argv, env);
  const timeoutMs = Math.max(10000, Number(env.RECURSION_LIVE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS));
  const verifierExit = runInstalledCopyVerifierCli(['--user', user], {
    cwd: process.cwd(),
    environment: env,
    stdout: { write() {} },
    stderr: { write() {} }
  });
  if (verifierExit !== 0) fail('stale-extension', 'Repository, installed, and served Recursion copies do not match.');

  const session = createSillyTavernHttpSession({
    baseUrl: env.SILLYTAVERN_BASE_URL,
    user,
    password: passwordForUser(user, env)
  });
  await session.init();
  await session.login();
  const browser = await chromium.launch({ headless: env.RECURSION_SILLYTAVERN_HEADLESS !== '0' });
  try {
    const context = await browser.newContext();
    await context.addCookies(session.playwrightCookies());
    await context.addInitScript(() => { globalThis.__recursionLiveHarness = true; });
    const page = await context.newPage();
    await page.goto(env.SILLYTAVERN_BASE_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForSelector('#recursion-root', { timeout: timeoutMs });
    await page.waitForFunction(() => Boolean(globalThis.__recursionLiveHarnessRuntime), null, { timeout: timeoutMs });
    const target = await selectTargetChat(page, {
      characterName: env.RECURSION_LIVE_CHARACTER,
      chatFile: env.RECURSION_LIVE_CHAT_FILE,
      timeoutMs
    });
    const settingsResult = await page.evaluate(() => globalThis.__recursionLiveHarnessRuntime.updateSettings({
      enabled: true,
      postProcess: {
        enabled: true,
        applyMode: 'as-swipe',
        rewriteFlow: 'unified'
      }
    }));
    if (settingsResult?.ok === false) fail('settings-failed', 'Could not force Post-process As Swipe.', settingsResult);
    const before = await assistantState(page);
    if (before.index < 0 || before.swipeCount < 1) {
      fail('assistant-unavailable', 'The target chat requires a latest assistant response with native swipe state.', before);
    }
    if (before.swipeId !== before.swipeCount - 1) {
      fail('latest-swipe-not-selected', 'Select the latest existing swipe before running strict Post-process certification.', {
        messageId: before.messageId,
        swipeId: before.swipeId,
        swipeCount: before.swipeCount
      });
    }
    const swipe = page.locator(
      `.mes[mesid="${before.messageId}"] .swipe_right, .mes[data-message-id="${before.messageId}"] .swipe_right, #chat .mes:last-child .swipe_right`
    ).last();
    if (!(await swipe.isVisible().catch(() => false))) fail('swipe-control-unavailable', 'Native latest-assistant swipe control is unavailable.');
    await swipe.click({ timeout: timeoutMs });

    const deadline = Date.now() + timeoutMs;
    let after = null;
    let postProcessSourceSwipeCount = null;
    let stopObservedDuringPostProcess = false;
    while (Date.now() < deadline) {
      after = await assistantState(page, before.messageId);
      if (after.postProcessPending || after.postProcessRunning) {
        stopObservedDuringPostProcess ||= after.nativeStopVisible;
      }
      if (after.postProcessRunning && postProcessSourceSwipeCount === null) {
        postProcessSourceSwipeCount = after.swipeCount;
      }
      if (postProcessSourceSwipeCount !== null
        && !after.postProcessPending
        && !after.postProcessRunning
        && !after.hostGenerationActive
        && after.swipeCount >= postProcessSourceSwipeCount + 1) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (postProcessSourceSwipeCount === null) {
      fail('post-process-not-observed', 'Post-process never became active after native generation.', {
        messageId: before.messageId,
        finalSwipeCount: after?.swipeCount ?? null
      });
    }
    if (!after || after.swipeCount !== postProcessSourceSwipeCount + 1) {
      fail('second-swipe-missing', 'Post-process must add exactly one swipe to its completed native source.', {
        postProcessSourceSwipeCount,
        afterSwipeCount: after?.swipeCount ?? null
      });
    }
    if (after.swipeId !== postProcessSourceSwipeCount
      || after.swipeInfoLength !== after.swipeCount
      || !after.markerValid
      || !stopObservedDuringPostProcess) {
      fail('post-process-swipe-invalid', 'The selected Post-process swipe or lifecycle evidence is invalid.', {
        postProcessSourceSwipeCount,
        after,
        stopObservedDuringPostProcess
      });
    }

    await page.evaluate(async (chatFile) => {
      const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.();
      await context.saveChat();
      await context.openCharacterChat(chatFile);
    }, target.chatFile);
    await page.waitForFunction((messageId) => {
      const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
      return context.chat?.some((entry, index) => Number(entry?.mesid ?? index) === Number(messageId));
    }, before.messageId, { timeout: timeoutMs });
    const persisted = await assistantState(page, before.messageId);
    if (persisted.swipeCount !== postProcessSourceSwipeCount + 1
      || persisted.swipeId !== postProcessSourceSwipeCount
      || persisted.swipeInfoLength !== persisted.swipeCount
      || !persisted.markerValid) {
      fail('persisted-second-swipe-invalid', 'Reloaded chat did not preserve the selected Post-process swipe.', persisted);
    }
    console.log(JSON.stringify({
      status: 'pass',
      result: 'live-post-process-as-swipe-pass',
      user,
      target,
      postProcessSourceSwipeCount,
      afterSwipeCount: persisted.swipeCount,
      selectedSwipeId: persisted.swipeId,
      markerSchema: persisted.markerSchema,
      stopObservedDuringPostProcess
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: 'fail',
    result: error.result || 'live-post-process-as-swipe-error',
    error: error.message,
    details: error.details || null
  }, null, 2));
  process.exit(1);
});
