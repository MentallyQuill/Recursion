import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addCheck,
  attachReportArtifacts,
  computeBrowserSmokeTimeoutMs,
  createBaseReport,
  exitCodeForReport,
  finalizeReport,
  normalizeSoakUserHandle,
  printReportAndSetExitCode,
  rejectUnsafeLiveUser,
  reportToSummary,
  runPlaywrightReadiness,
  runSillyTavernLiveSmoke,
  runSoakUsersPreflight,
  setReportStatus,
  validateSoakUserHandle,
  validateSoakUserList
} from './lib/sillytavern-live-harness.mjs';
import { assert, assertDeepEqual, assertEqual, assertRejects } from '../../tests/helpers/assert.mjs';

function createJsonResponse(status, value, headers = {}) {
  const text = value === undefined ? '' : JSON.stringify(value);
  const lowerHeaders = Object.fromEntries(Object.entries(headers).map(([key, headerValue]) => [key.toLowerCase(), headerValue]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        return lowerHeaders[String(name).toLowerCase()] ?? null;
      },
      getSetCookie() {
        const value = lowerHeaders['set-cookie'];
        return value ? [value] : [];
      }
    },
    async text() {
      return text;
    }
  };
}

function createFakeSillyTavernFetch({ users = {}, failDeleteFor = [] } = {}) {
  const state = {
    calls: [],
    failDeleteFor: new Set(failDeleteFor),
    sessions: new Map(),
    users: Object.fromEntries(Object.entries(users).map(([handle, config]) => [handle, {
      password: config.password || '',
      files: new Map()
    }]))
  };
  let nextSession = 1;

  function sessionFromHeaders(headers = {}) {
    const cookie = headers.Cookie || headers.cookie || '';
    const match = String(cookie).match(/sid=([^;]+)/);
    if (match && state.sessions.has(match[1])) return state.sessions.get(match[1]);
    const sid = `session-${nextSession++}`;
    const session = { sid, csrf: `csrf-${sid}`, user: null };
    state.sessions.set(sid, session);
    return session;
  }

  function requireCsrf(session, headers = {}) {
    return (headers['X-CSRF-Token'] || headers['x-csrf-token']) === session.csrf;
  }

  function requireUser(session) {
    return session.user && state.users[session.user] ? state.users[session.user] : null;
  }

  async function fetchImpl(url, options = {}) {
    const parsed = new URL(url);
    const pathName = parsed.pathname;
    const method = options.method || 'GET';
    const headers = options.headers || {};
    const body = options.body ? JSON.parse(options.body) : {};
    const session = sessionFromHeaders(headers);
    state.calls.push({ method, pathName, user: session.user, body, cookie: headers.Cookie || headers.cookie || '' });

    if (method === 'GET' && pathName === '/csrf-token') {
      return createJsonResponse(200, { token: session.csrf }, { 'set-cookie': `sid=${session.sid}; Path=/; HttpOnly` });
    }

    if (method === 'POST' && pathName === '/api/users/login') {
      if (!requireCsrf(session, headers)) return createJsonResponse(403, { error: 'bad csrf' });
      const user = state.users[body.handle];
      if (!user || user.password !== (body.password || '')) return createJsonResponse(403, { error: 'bad credentials' });
      session.user = body.handle;
      return createJsonResponse(200, { handle: body.handle });
    }

    if (!requireCsrf(session, headers) && method === 'POST') return createJsonResponse(403, { error: 'bad csrf' });
    const user = requireUser(session);
    if (!user) return createJsonResponse(403, { error: 'not logged in' });

    if (method === 'POST' && pathName === '/api/files/upload') {
      user.files.set(body.name, Buffer.from(body.data, 'base64').toString('utf8'));
      return createJsonResponse(200, { path: `/user/files/${body.name}` });
    }

    if (method === 'POST' && pathName === '/api/files/verify') {
      return createJsonResponse(200, Object.fromEntries((body.urls || []).map((entry) => {
        const fileName = decodeURIComponent(String(entry).replace('/user/files/', ''));
        return [entry, user.files.has(fileName)];
      })));
    }

    if (method === 'GET' && pathName.startsWith('/user/files/')) {
      const fileName = decodeURIComponent(pathName.slice('/user/files/'.length));
      if (!user.files.has(fileName)) return createJsonResponse(404, { error: 'missing' });
      return createJsonResponse(200, JSON.parse(user.files.get(fileName)));
    }

    if (method === 'POST' && pathName === '/api/files/delete') {
      const fileName = decodeURIComponent(String(body.path || '').replace('/user/files/', ''));
      if (state.failDeleteFor.has(fileName) || [...state.failDeleteFor].some((entry) => fileName.includes(entry))) {
        return createJsonResponse(500, { error: 'delete failed' });
      }
      if (!user.files.has(fileName)) return createJsonResponse(404, { error: 'missing' });
      user.files.delete(fileName);
      return createJsonResponse(200, {});
    }

    return createJsonResponse(404, { error: 'unknown endpoint' });
  }

  return { fetchImpl, state };
}

function parseCookieHeader(header = '') {
  return Object.fromEntries(String(header || '').split(';').map((entry) => {
    const separator = entry.indexOf('=');
    if (separator <= 0) return null;
    return [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()];
  }).filter(Boolean));
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(value));
}

function sendText(response, status, text, headers = {}) {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
  response.end(text);
}

function recursionSmokeFixtureHtml({
  missingDisableHook = false,
  omitPromptPacketMetadata = false,
  asyncUiGeneration = false,
  ignorePromptClear = false,
  omitVisibleSendMarker = false,
  omitHostGenerationContinuation = false,
  sendControlsDisabled = false,
  manualSkipsPrompt = false,
  manualInterceptorNeverResolves = false,
  manualModeSave = 'sync',
  unclearedPromptOnDisable = false,
  disableHookNeverResolves = false,
  staleModeChip = false,
  reasonerFallback = false,
  directBridgeNeverResolves = false,
  visibleSendButtonClicksIgnored = false,
  sendSurface = 'complete',
  storyChatAvailable = false
} = {}) {
  const disableHookScript = missingDisableHook
    ? ''
      : disableHookNeverResolves
        ? "globalThis.recursionOnDisable = async function recursionOnDisable() { if (!smokeContext.unclearedPromptOnDisable) { smokeContext.setExtensionPrompt('recursion.guidance', '', 'IN_PROMPT', 4, false, 'SYSTEM'); smokeContext.setExtensionPrompt('recursion.cardEvidence', '', 'IN_PROMPT', 4, false, 'SYSTEM'); } if (globalThis.__recursionSmokePromptClearActive === true) await new Promise(() => {}); return true; };"
        : "globalThis.recursionOnDisable = function recursionOnDisable() { if (!smokeContext.unclearedPromptOnDisable) { smokeContext.setExtensionPrompt('recursion.guidance', '', 'IN_PROMPT', 4, false, 'SYSTEM'); smokeContext.setExtensionPrompt('recursion.cardEvidence', '', 'IN_PROMPT', 4, false, 'SYSTEM'); } return true; };";
  const reasonerFallbackFlag = reasonerFallback ? 'true' : 'false';
  const promptPacketMetadataExpression = omitPromptPacketMetadata
    ? "JSON.stringify({ packetId: '', handId: '', selectedCardRefs: [] })"
    : reasonerFallback
      ? "JSON.stringify({ packetId: 'packet-smoke', handId: 'hand-smoke', selectedCardRefs: (Array.isArray(smokeContext.manualForcedFamilies) && smokeContext.manualForcedFamilies.length ? smokeContext.manualForcedFamilies.map((family, index) => ({ id: `forced-${index}`, family })) : (smokeContext.disabledFamilies.includes('Scene Frame') ? [{ id: 'open-thread', family: 'Open Threads' }] : [{ id: 'scene-frame', family: 'Scene Frame' }, { id: 'turn-brief', family: 'Open Threads' }])), diagnostics: { composerLane: 'utility', reasonerStatus: 'fallback', fallbackReason: 'reasoner raw failure text should be redacted' } })"
      : "JSON.stringify({ packetId: 'packet-smoke', handId: 'hand-smoke', selectedCardRefs: (Array.isArray(smokeContext.manualForcedFamilies) && smokeContext.manualForcedFamilies.length ? smokeContext.manualForcedFamilies.map((family, index) => ({ id: `forced-${index}`, family })) : (smokeContext.disabledFamilies.includes('Scene Frame') ? [{ id: 'open-thread', family: 'Open Threads' }] : [{ id: 'scene-frame', family: 'Scene Frame' }, { id: 'turn-brief', family: 'Open Threads' }])), diagnostics: { composerLane: 'utility', reasonerStatus: 'skipped' } })";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Recursion Smoke Fixture</title>
    <link rel="stylesheet" href="/scripts/extensions/third-party/Recursion/styles/recursion.css">
    <script id="recursion-script-probe" data-src="/scripts/extensions/third-party/Recursion/src/extension/index.js"></script>
  </head>
  <body>
    <main id="chat-root">
      <section id="recursion-root" class="recursion-root">
        <div class="recursion-bar" data-recursion-bar role="toolbar" aria-label="Recursion">
          <button type="button" data-recursion-power-toggle aria-pressed="true" aria-label="Turn Recursion off">Power</button>
          <span data-recursion-status>Ready</span>
          <span data-recursion-mode>Auto</span>
          <span data-recursion-hand-count>Hand 0</span>
          <span data-recursion-composer>Composer Utility</span>
          <span data-recursion-reasoner>Reasoner Auto</span>
          <button type="button" data-recursion-mode-button aria-label="Mode: Auto">Mode</button>
          <div data-recursion-mode-menu>
            <button type="button" data-recursion-mode-choice="auto" data-recursion-mode-choice-auto>Auto</button>
            <button type="button" data-recursion-mode-choice="manual" data-recursion-mode-choice-manual>Manual</button>
          </div>
          <button type="button" data-recursion-status-trigger>Status</button>
          <button type="button" data-recursion-actions>Actions</button>
          <button type="button" data-recursion-hand-toggle>Hand</button>
        </div>
        <div data-recursion-activity-ribbon role="status">
          <span data-recursion-ribbon-label>Ready</span>
        </div>
        <div data-recursion-status-popover hidden>Progress ready</div>
        <div data-recursion-hand-dropdown hidden>No hand has been composed for this chat.</div>
        <button type="button" data-recursion-cards-button aria-expanded="false">Cards</button>
        <div data-recursion-cards-panel hidden>
          <button type="button" data-recursion-card-scope-family-toggle data-recursion-card-scope-family-name="Scene Frame" aria-pressed="true">Scene Frame</button>
          <button type="button" data-recursion-card-scope-family-toggle data-recursion-card-scope-family-name="Active Cast" aria-pressed="true">Active Cast</button>
          <button type="button" data-recursion-card-scope-family-toggle data-recursion-card-scope-family-name="Open Threads" aria-pressed="true">Open Threads</button>
          <div data-recursion-card-scope-error role="status"></div>
          <span data-recursion-cards-label>Cards</span>
        </div>
        <div data-recursion-settings-panel hidden>
          <button type="button" data-recursion-viewer-toggle>Open Viewer</button>
          <select data-recursion-setting-mode aria-label="Mode"><option value="auto" selected>Auto</option><option value="manual">Manual</option></select>
          <input type="number" data-recursion-setting-max-cards aria-label="Max Cards" value="10">
          <select data-recursion-setting-reasoner aria-label="Reasoner Use"><option value="auto">Auto</option><option value="always">Always</option></select>
          <input type="checkbox" data-recursion-provider-enabled-reasoner aria-label="Reasoner enabled">
          <button type="button" data-recursion-provider-test data-recursion-provider-lane="utility">Test Provider</button>
          <button type="button" data-recursion-provider-toggle="reasoner" aria-expanded="true">Reasoner Provider</button>
          <span data-recursion-provider-status-reasoner>optional</span>
          <button type="button" data-recursion-provider-test data-recursion-provider-lane="reasoner">Test Reasoner Provider</button>
        </div>
        <dialog data-recursion-viewer aria-label="Recursion Viewer">
          <button type="button" data-recursion-viewer-close>Close</button>
          <h2>Recursion Viewer</h2>
          <pre data-recursion-prompt-packet>{}</pre>
        </dialog>
      </section>
      ${sendSurface === 'none' ? '' : `<section id="chat-input-area">
        ${sendSurface === 'button-only' ? '' : `<label for="send_textarea">Send message</label><textarea id="send_textarea" aria-label="Send a message"${sendControlsDisabled ? ' disabled' : ''}></textarea>`}
        ${sendSurface === 'input-only' ? '' : `<button id="send_but" type="button" aria-label="Send message"${sendControlsDisabled ? ' disabled' : ''}>Send</button>`}
      </section>`}
    </main>
    <script>
      const smokeContext = {
        chat: [],
        characters: [
          { name: 'Assistant', avatar: 'default_Assistant.png', chat: 'Assistant - fixture' },
          { name: 'Story', avatar: 'Story.png', chat: 'Branch #790 - 2025-08-28@18h02m24s' }
        ],
        characterId: 0,
        chatId: 'Assistant - fixture',
        prompts: {},
        enabled: true,
        mode: 'auto',
        disabledFamilies: [],
        manualForcedCap: 10,
        unclearedPromptOnDisable: ${unclearedPromptOnDisable ? 'true' : 'false'},
        async selectCharacterById(id) {
          const normalized = Number(id);
          if (!Number.isInteger(normalized) || !this.characters[normalized]) throw new Error('character missing');
          this.characterId = normalized;
          this.chatId = this.characters[normalized].chat;
          return true;
        },
        async openCharacterChat(fileName) {
          const active = this.characters[this.characterId];
          if (!active) throw new Error('active character missing');
          if (active.name !== 'Story' || fileName !== 'Branch #790 - 2025-08-28@18h02m24s' || !${storyChatAvailable ? 'true' : 'false'}) {
            throw new Error('chat missing');
          }
          active.chat = fileName;
          this.chatId = fileName;
          this.chat = [
            { mesid: 0, is_user: false, name: 'Hermione Granger', mes: 'Story branch seed assistant line.' },
            { mesid: 1, is_user: true, name: 'Keptin', mes: 'Story branch seed user line.' },
            { mesid: 2, is_user: false, name: 'Hermione Granger', mes: 'Story branch #790 seed ready.' }
          ];
          return true;
        },
        setExtensionPrompt(key, text, position, depth, scan, role) {
          if (${ignorePromptClear ? 'true' : 'false'} && String(key || '').startsWith('recursion.') && String(text || '') === '') return;
          this.prompts[key] = { text, position, depth, scan, role };
        }
      };
      globalThis.SillyTavern = { getContext: () => smokeContext };
      if (smokeContext.unclearedPromptOnDisable) {
        smokeContext.setExtensionPrompt('recursion.guidance', 'Recursion stale disabled baseline prompt.', 'IN_PROMPT', 4, false, 'SYSTEM');
      }
      globalThis.recursionGenerationInterceptor = async function recursionGenerationInterceptor(chat) {
        const sourceChat = Array.isArray(chat) ? chat : smokeContext.chat;
        const activeMode = smokeContext.mode || document.querySelector('[data-recursion-setting-mode]')?.value || 'auto';
        if (${directBridgeNeverResolves ? 'true' : 'false'} && activeMode !== 'manual') {
          await new Promise(() => {});
        }
        const activeModeLabel = activeMode === 'manual' ? 'Manual' : 'Auto';
        const renderGenerationUi = () => {
          document.querySelector('[data-recursion-status]').textContent = 'Ready';
          if (!${staleModeChip ? 'true' : 'false'}) {
            document.querySelector('[data-recursion-mode]').textContent = activeModeLabel;
          }
          if (${reasonerFallbackFlag} && activeMode === 'auto') {
            document.querySelector('[data-recursion-reasoner]').textContent = 'Reasoner fallback';
          }
          document.querySelector('[data-recursion-hand-count]').textContent = 'Hand 2';
          document.querySelector('[data-recursion-ribbon-label]').textContent = ${reasonerFallbackFlag} ? 'Reasoner unavailable. Utility composed.' : 'Recursion prompt ready.';
          document.querySelector('[data-recursion-prompt-packet]').textContent = ${promptPacketMetadataExpression};
        };
        if (activeMode === 'manual' && ${manualSkipsPrompt ? 'true' : 'false'}) {
          renderGenerationUi();
          return sourceChat;
        }
        smokeContext.setExtensionPrompt('recursion.guidance', 'Recursion smoke guidance.', 'IN_PROMPT', 4, false, 'SYSTEM');
        smokeContext.setExtensionPrompt('recursion.cardEvidence', 'Recursion smoke card evidence.', 'IN_PROMPT', 4, false, 'SYSTEM');
        if (${asyncUiGeneration ? 'true' : 'false'}) setTimeout(renderGenerationUi, 650);
        else renderGenerationUi();
        if (activeMode === 'manual' && ${manualInterceptorNeverResolves ? 'true' : 'false'}) {
          await new Promise(() => {});
        }
        return sourceChat;
      };
      globalThis.recursionOnEnable = function recursionOnEnable() { return true; };
      ${disableHookScript}
      document.querySelector('[data-recursion-power-toggle]')?.addEventListener('click', () => {
        smokeContext.enabled = !smokeContext.enabled;
        const button = document.querySelector('[data-recursion-power-toggle]');
        button?.setAttribute('aria-pressed', smokeContext.enabled ? 'true' : 'false');
        button?.setAttribute('aria-label', smokeContext.enabled ? 'Turn Recursion off' : 'Turn Recursion on');
        if (!smokeContext.enabled) {
          for (const key of ['recursion.guidance', 'recursion.cardEvidence', 'recursion.guardrails']) {
            smokeContext.setExtensionPrompt(key, '', 'IN_PROMPT', 0, false, 'SYSTEM');
          }
          document.querySelector('[data-recursion-status]').textContent = 'Off';
        } else {
          document.querySelector('[data-recursion-status]').textContent = 'Ready';
        }
      });
      async function sendSmokeMessage() {
        const input = document.querySelector('#send_textarea');
        const message = {
          mesid: smokeContext.chat.length,
          is_user: true,
          name: 'Recursion Smoke',
          mes: String(input?.value || '')
        };
        smokeContext.chat.push(message);
        await globalThis.recursionGenerationInterceptor(smokeContext.chat);
        if (!${omitHostGenerationContinuation ? 'true' : 'false'}) {
          smokeContext.chat.push({
            mesid: smokeContext.chat.length,
            is_user: false,
            name: 'Recursion Smoke Host',
            mes: 'Recursion smoke host generation continued.'
          });
          globalThis.__recursionSmokeHostGeneration = {
            ok: true,
            chatLength: smokeContext.chat.length
          };
        }
        if (!${omitVisibleSendMarker ? 'true' : 'false'}) {
          globalThis.__recursionSmokeVisibleSend = {
            ok: true,
            chatLength: smokeContext.chat.length,
            messageLength: message.mes.length
          };
        }
      }
      document.querySelector('#send_textarea')?.addEventListener('keydown', async (event) => {
        if (event.key !== 'Enter' || event.shiftKey) return;
        event.preventDefault();
        await sendSmokeMessage();
      });
      document.querySelector('#send_but')?.addEventListener('click', async () => {
        if (${visibleSendButtonClicksIgnored ? 'true' : 'false'}) return;
        await sendSmokeMessage();
      });
      document.querySelector('[data-recursion-actions]').addEventListener('click', () => {
        const panel = document.querySelector('[data-recursion-settings-panel]');
        panel.hidden = !panel.hidden;
      });
      document.querySelector('[data-recursion-cards-button]')?.addEventListener('click', () => {
        const panel = document.querySelector('[data-recursion-cards-panel]');
        panel.hidden = !panel.hidden;
        document.querySelector('[data-recursion-cards-button]')?.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
      });
      function updateCardScopeFixtureLabel() {
        const selected = [...document.querySelectorAll('[data-recursion-card-scope-family-toggle]')]
          .filter((button) => button.getAttribute('aria-pressed') !== 'false')
          .length;
        const cap = smokeContext.mode === 'manual' ? smokeContext.manualForcedCap : 3;
        document.querySelector('[data-recursion-cards-label]').textContent = selected === 3 && smokeContext.mode !== 'manual'
          ? 'Cards'
          : String(selected) + '/' + String(cap) + ' cards selected';
      }
      function rerenderCardScopeFixtureButtons() {
        for (const button of [...document.querySelectorAll('[data-recursion-card-scope-family-toggle]')]) {
          button.replaceWith(button.cloneNode(true));
        }
      }
      document.querySelector('[data-recursion-cards-panel]')?.addEventListener('click', (event) => {
          const button = event.target?.closest?.('[data-recursion-card-scope-family-toggle]');
          if (!button) return;
          const family = String(button.dataset.recursionCardScopeFamilyName || '');
          const selected = [...document.querySelectorAll('[data-recursion-card-scope-family-toggle]')]
            .filter((node) => node.getAttribute('aria-pressed') !== 'false')
            .map((node) => String(node.dataset.recursionCardScopeFamilyName || ''));
          const currentlyOn = button.getAttribute('aria-pressed') !== 'false';
          const notice = document.querySelector('[data-recursion-card-scope-error]');
          if (!currentlyOn && smokeContext.mode === 'manual' && selected.length >= smokeContext.manualForcedCap) {
            if (notice) notice.textContent = 'Max Cards is ' + smokeContext.manualForcedCap + '. Change it in Settings to select more.';
            return;
          }
          if (notice) notice.textContent = '';
          if (currentlyOn) {
            smokeContext.disabledFamilies.push(family);
            button.setAttribute('aria-pressed', 'false');
          } else {
            smokeContext.disabledFamilies = smokeContext.disabledFamilies.filter((entry) => entry !== family);
            button.setAttribute('aria-pressed', 'true');
          }
          updateCardScopeFixtureLabel();
          rerenderCardScopeFixtureButtons();
      });
      function applyFixtureMaxCards(value) {
        const number = Math.round(Number(value));
        smokeContext.manualForcedCap = Number.isFinite(number) ? Math.max(1, Math.min(20, number)) : 10;
        updateCardScopeFixtureLabel();
      }
      document.querySelector('[data-recursion-setting-max-cards]')?.addEventListener('input', (event) => {
        applyFixtureMaxCards(event.target?.value);
      });
      document.querySelector('[data-recursion-setting-max-cards]')?.addEventListener('change', (event) => {
        applyFixtureMaxCards(event.target?.value);
      });
      function applyModeChange(mode) {
        const applyMode = () => {
          smokeContext.mode = mode;
          const modeSelect = document.querySelector('[data-recursion-setting-mode]');
          if (modeSelect) modeSelect.value = mode;
          document.querySelector('[data-recursion-status]').textContent = smokeContext.enabled ? 'Ready' : 'Off';
          if (!${staleModeChip ? 'true' : 'false'}) {
            document.querySelector('[data-recursion-mode]').textContent = mode === 'manual' ? 'Manual' : 'Auto';
          }
          updateCardScopeFixtureLabel();
        };
        if ('${manualModeSave}' === 'noop' && mode === 'manual') return;
        if ('${manualModeSave}' === 'async' && mode === 'manual') setTimeout(applyMode, 150);
        else applyMode();
      }
      document.querySelector('[data-recursion-setting-mode]').addEventListener('change', (event) => {
        applyModeChange(event.target?.value || 'auto');
      });
      document.querySelector('[data-recursion-provider-test][data-recursion-provider-lane="reasoner"]')?.addEventListener('click', () => {
        document.querySelector('[data-recursion-provider-status-reasoner]').textContent = 'pass';
      });
      document.querySelectorAll('[data-recursion-mode-choice]').forEach((button) => {
        button.addEventListener('click', () => {
          applyModeChange(button.getAttribute('data-recursion-mode-choice') || 'auto');
        });
      });
      document.querySelector('[data-recursion-hand-toggle]').addEventListener('click', () => {
        const panel = document.querySelector('[data-recursion-hand-dropdown]');
        panel.hidden = !panel.hidden;
      });
      document.querySelector('[data-recursion-status-trigger]').addEventListener('click', () => {
        const panel = document.querySelector('[data-recursion-status-popover]');
        panel.hidden = !panel.hidden;
      });
      document.querySelector('[data-recursion-viewer-toggle]').addEventListener('click', () => {
        const viewer = document.querySelector('[data-recursion-viewer]');
        if (viewer.showModal) viewer.showModal();
        else viewer.hidden = false;
      });
      document.querySelector('[data-recursion-viewer-close]').addEventListener('click', () => {
        const viewer = document.querySelector('[data-recursion-viewer]');
        if (viewer.close) viewer.close();
        else viewer.hidden = true;
      });
    </script>
  </body>
</html>`;
}

async function createSillyTavernSmokeFixtureServer({
  serveExtension = true,
  mismatchManifest = false,
  staleModule = null,
  missingDisableHook = false,
  omitPromptPacketMetadata = false,
  asyncUiGeneration = false,
  ignorePromptClear = false,
  omitVisibleSendMarker = false,
  omitHostGenerationContinuation = false,
  sendControlsDisabled = false,
  manualSkipsPrompt = false,
  manualInterceptorNeverResolves = false,
  manualModeSave = 'sync',
  unclearedPromptOnDisable = false,
  disableHookNeverResolves = false,
  staleModeChip = false,
  reasonerFallback = false,
  directBridgeNeverResolves = false,
  visibleSendButtonClicksIgnored = false,
  sendSurface = 'complete',
  storyChatAvailable = false
} = {}) {
  const sessions = new Map();
  let nextSession = 1;
  const users = {
    'recursion-soak-a': {
      password: '',
      files: new Map()
    }
  };
  const extensionFiles = {
    '/scripts/extensions/third-party/Recursion/manifest.json': {
      type: 'application/json',
      text: mismatchManifest
        ? JSON.stringify({ ...JSON.parse(readFileSync('manifest.json', 'utf8')), version: 'stale-fixture' }, null, 2)
        : readFileSync('manifest.json', 'utf8')
    },
    '/scripts/extensions/third-party/Recursion/styles/recursion.css': {
      type: 'text/css',
      text: readFileSync('styles/recursion.css', 'utf8')
    }
  };
  const moduleFiles = [
    'src/extension/index.js',
    'src/activity.mjs',
    'src/card-scope.mjs',
    'src/cards.mjs',
    'src/core.mjs',
    'src/hosts/sillytavern/host.mjs',
    'src/hosts/sillytavern/storage.mjs',
    'src/progress.mjs',
    'src/prompt.mjs',
    'src/providers.mjs',
    'src/providers/provider-response-normalizer.mjs',
    'src/providers/structured-output-parser.mjs',
    'src/rapid-pipeline.mjs',
    'src/rapid-warm-state.mjs',
    'src/reasoning-policy.mjs',
    'src/retention-policy.mjs',
    'src/runtime.mjs',
    'src/settings.mjs',
    'src/settings-policy.mjs',
    'src/storage.mjs',
    'src/story-form.mjs',
    'src/ui.mjs'
  ];
  for (const relativePath of moduleFiles) {
    const text = readFileSync(relativePath, 'utf8');
    extensionFiles[`/scripts/extensions/third-party/Recursion/${relativePath}`] = {
      type: 'text/javascript',
      text: relativePath === staleModule ? `${text}\n// stale fixture module\n` : text
    };
  }

  function sessionFromRequest(request) {
    const cookies = parseCookieHeader(request.headers.cookie || '');
    const existing = cookies.sid && sessions.get(cookies.sid);
    if (existing) return existing;
    const sid = `fixture-${nextSession++}`;
    const session = { sid, csrf: `csrf-${sid}`, user: null };
    sessions.set(sid, session);
    return session;
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const session = sessionFromRequest(request);

    if (request.method === 'GET' && url.pathname === '/csrf-token') {
      sendJson(response, 200, { token: session.csrf }, { 'set-cookie': `sid=${session.sid}; Path=/; HttpOnly` });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/users/login') {
      const body = await readRequestJson(request);
      const csrf = request.headers['x-csrf-token'];
      if (csrf !== session.csrf) {
        sendJson(response, 403, { error: 'bad csrf' });
        return;
      }
      const user = users[body.handle];
      if (!user || user.password !== (body.password || '')) {
        sendJson(response, 403, { error: 'bad credentials' });
        return;
      }
      session.user = body.handle;
      sendJson(response, 200, { handle: body.handle }, { 'set-cookie': `sid=${session.sid}; Path=/; HttpOnly` });
      return;
    }

    const user = session.user ? users[session.user] : null;
    if (request.method === 'POST' && ['/api/files/upload', '/api/files/verify', '/api/files/delete'].includes(url.pathname)) {
      if (!user || request.headers['x-csrf-token'] !== session.csrf) {
        sendJson(response, 403, { error: 'not authorized' });
        return;
      }
      const body = await readRequestJson(request);
      if (url.pathname === '/api/files/upload') {
        user.files.set(body.name, Buffer.from(body.data, 'base64').toString('utf8'));
        sendJson(response, 200, { path: `/user/files/${body.name}` });
        return;
      }
      if (url.pathname === '/api/files/verify') {
        sendJson(response, 200, Object.fromEntries((body.urls || []).map((entry) => {
          const fileName = decodeURIComponent(String(entry).replace('/user/files/', ''));
          return [entry, user.files.has(fileName)];
        })));
        return;
      }
      if (url.pathname === '/api/files/delete') {
        const fileName = decodeURIComponent(String(body.path || '').replace('/user/files/', ''));
        if (!user.files.has(fileName)) {
          sendJson(response, 404, { error: 'missing' });
          return;
        }
        user.files.delete(fileName);
        sendJson(response, 200, {});
        return;
      }
    }

    if (request.method === 'GET' && url.pathname.startsWith('/user/files/')) {
      if (!user) {
        sendJson(response, 403, { error: 'not authorized' });
        return;
      }
      const fileName = decodeURIComponent(url.pathname.slice('/user/files/'.length));
      if (!user.files.has(fileName)) {
        sendJson(response, 404, { error: 'missing' });
        return;
      }
      sendText(response, 200, user.files.get(fileName), { 'content-type': 'application/json' });
      return;
    }

    if (request.method === 'GET' && extensionFiles[url.pathname] && serveExtension) {
      const file = extensionFiles[url.pathname];
      sendText(response, 200, file.text, { 'content-type': file.type });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/') {
      if (!session.user) {
        sendText(response, 403, '<!doctype html><title>login required</title>');
        return;
      }
      sendText(response, 200, recursionSmokeFixtureHtml({
        missingDisableHook,
        omitPromptPacketMetadata,
        asyncUiGeneration,
        ignorePromptClear,
        omitVisibleSendMarker,
        omitHostGenerationContinuation,
        sendControlsDisabled,
        manualSkipsPrompt,
        manualInterceptorNeverResolves,
        manualModeSave,
        unclearedPromptOnDisable,
        disableHookNeverResolves,
        staleModeChip,
        reasonerFallback,
        directBridgeNeverResolves,
        visibleSendButtonClicksIgnored,
        sendSurface,
        storyChatAvailable
      }));
      return;
    }

    sendJson(response, 404, { error: 'missing' });
  });

  await new Promise((resolveServer) => server.listen(0, '127.0.0.1', resolveServer));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close() {
      return new Promise((resolveClose) => server.close(resolveClose));
    },
    users
  };
}

assertEqual(normalizeSoakUserHandle(' Recursion-Soak-A '), 'recursion-soak-a', 'user handles normalize to trimmed lowercase');
assertDeepEqual(validateSoakUserHandle('recursion-soak-a').ok, true, 'recursion soak user accepted');
assertEqual(validateSoakUserHandle('default-user').status, 'unsafe-user', 'default-user rejected');
assertEqual(validateSoakUserHandle('default').reason, 'default-profile-alias', 'default alias rejected');
assertEqual(validateSoakUserHandle('directive-soak-a').reason, 'non-dedicated-user', 'non-recursion soak rejected');
assertEqual(validateSoakUserHandle('').reason, 'missing-user', 'empty user rejected');
assertEqual(validateSoakUserList('recursion-soak-a, recursion-soak-b').status, 'pass', 'safe user list passes');
assertEqual(validateSoakUserList('recursion-soak-a, default-user').status, 'unsafe-user', 'mixed unsafe user list fails');
assertEqual(validateSoakUserList('recursion-soak-a, recursion-soak-a').failed[0].reason, 'duplicate-user', 'duplicate soak users rejected');
assertEqual(computeBrowserSmokeTimeoutMs({ generationRequested: true, timeoutMs: 120000 }), 390000, 'generation browser timeout leaves room for manual proof, generation assertion, host continuation, and cleanup');
assertEqual(computeBrowserSmokeTimeoutMs({ generationRequested: false, timeoutMs: 30000 }), 45000, 'no-generation browser timeout remains compact');
await assertRejects(() => rejectUnsafeLiveUser('default-user'), /Unsafe SillyTavern live-test user/, 'rejectUnsafeLiveUser throws on default-user');

{
  const report = await runSoakUsersPreflight({
    argv: [],
    env: {}
  });
  assertEqual(report.status, 'skipped', 'soak preflight with no users is a dry-run checklist');
  assert(report.checks.some((check) => check.name === 'dedicated-user-policy' && check.status === 'skipped'), 'missing users are skipped in dry-run mode');
}

{
  const report = await runSoakUsersPreflight({
    argv: [],
    env: {
      RECURSION_SOAK_ST_USERS: 'recursion-soak-a,recursion-soak-b',
      SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000'
    }
  });
  assertEqual(report.status, 'skipped', 'soak preflight dry run is skipped');
  assertEqual(report.result, 'dry-run', 'soak preflight dry run result');
  assert(report.checks.some((check) => check.name === 'live-mutation' && check.status === 'skipped'), 'dry run reports no mutation');
}

{
  const report = await runSoakUsersPreflight({
    argv: ['--live'],
    env: {
      RECURSION_SOAK_ST_USERS: 'default-user',
      SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000'
    }
  });
  assertEqual(report.status, 'unsafe-user', 'live soak preflight rejects default-user before mutation');
  assert(!report.checks.some((check) => check.name === 'storage-isolation-probe'), 'unsafe users stop before storage probe');
}

{
  const report = await runSoakUsersPreflight({
    argv: ['--live'],
    env: {
      RECURSION_SOAK_ST_USERS: 'recursion-soak-a'
    }
  });
  assertEqual(report.status, 'environment-fail', 'live soak preflight requires base url after safe user passes');
  assert(report.checks.some((check) => check.name === 'base-url'), 'base url check is reported');
}

{
  const fakeHost = createFakeSillyTavernFetch({
    users: {
      'recursion-soak-a': {},
      'recursion-soak-b': { password: 'shared-secret' }
    }
  });
  const artifactRoot = mkdtempSync(join(tmpdir(), 'recursion-storage-probe-'));
  try {
    const report = await runSoakUsersPreflight({
      argv: ['--live', '--write-artifacts'],
      env: {
        SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000',
        RECURSION_SOAK_ST_USERS: 'recursion-soak-a,recursion-soak-b',
        RECURSION_SILLYTAVERN_PASSWORD_RECURSION_SOAK_B: 'shared-secret'
      },
      artifactRoot,
      fetchImpl: fakeHost.fetchImpl
    });
    assertEqual(report.status, 'pass', 'storage probe passes for two dedicated users');
    assertEqual(report.result, 'storage-probe-pass', 'storage probe result is explicit');
    assertEqual(report.storageProbe.probes.length, 2, 'storage probe writes one probe per user');
    assertEqual(report.storageProbe.isolationChecks.length, 2, 'storage probe checks cross-user isolation in both directions');
    assert(report.storageProbe.cleanup.every((entry) => entry.status === 'deleted'), 'storage probe cleanup deletes all probe files');
    const authenticatedCall = fakeHost.state.calls.find((entry) => entry.pathName === '/api/files/upload');
    assert(authenticatedCall.cookie.includes('sid=session-'), 'authenticated storage calls send a session cookie');
    assert(!authenticatedCall.cookie.includes('Path='), 'authenticated storage calls do not echo cookie attributes');
    assert(!authenticatedCall.cookie.includes('HttpOnly'), 'authenticated storage calls keep HttpOnly out of Cookie headers');
    assertDeepEqual([...fakeHost.state.users['recursion-soak-a'].files.keys()], [], 'soak-a probe files cleaned up');
    assertDeepEqual([...fakeHost.state.users['recursion-soak-b'].files.keys()], [], 'soak-b probe files cleaned up');
    assertEqual(report.artifacts.storageProbe, 'storage/probe.json', 'storage probe artifact path is relative');
    const runRoot = join(artifactRoot, 'live-smoke', 'sillytavern', report.runId);
    const probeArtifact = readFileSync(join(runRoot, 'storage', 'probe.json'), 'utf8');
    assert(probeArtifact.includes('"storage-probe-pass"'), 'storage probe artifact persisted');
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
}

{
  const fakeHost = createFakeSillyTavernFetch({ users: {} });
  const report = await runSoakUsersPreflight({
    argv: ['--live'],
    env: {
      SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000',
      RECURSION_SOAK_ST_USERS: 'recursion-soak-a'
    },
    fetchImpl: fakeHost.fetchImpl
  });
  assertEqual(report.status, 'environment-fail', 'missing soak user fails through login');
  assertEqual(report.result, 'login-failed', 'missing soak user reports login failure');
  assertEqual(report.storageProbe.probes.length, 0, 'login failure writes no probe files');
}

{
  const fakeHost = createFakeSillyTavernFetch({
    users: {
      'recursion-soak-a': {}
    }
  });
  const report = await runSoakUsersPreflight({
    argv: ['--live'],
    env: {
      SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000',
      RECURSION_SOAK_ST_USERS: 'recursion-soak-a,recursion-soak-b'
    },
    fetchImpl: fakeHost.fetchImpl
  });
  assertEqual(report.status, 'environment-fail', 'mixed existing and missing users fail before mutation');
  assertEqual(report.result, 'login-failed', 'mixed missing user reports login failure');
  assertEqual(report.storageProbe.probes.length, 0, 'mixed missing user writes no probe files before all users authenticate');
  assertDeepEqual([...fakeHost.state.users['recursion-soak-a'].files.keys()], [], 'authenticated earlier user has no probe file after later login failure');
}

{
  const fakeHost = createFakeSillyTavernFetch({
    users: {
      'recursion-soak-a': {}
    },
    failDeleteFor: ['recursion-soak-a']
  });
  const report = await runSoakUsersPreflight({
    argv: ['--live'],
    env: {
      SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000',
      RECURSION_SOAK_ST_USERS: 'recursion-soak-a'
    },
    fetchImpl: fakeHost.fetchImpl
  });
  assertEqual(report.status, 'fail', 'cleanup failure fails storage probe run');
  assertEqual(report.result, 'storage-probe-cleanup-failed', 'cleanup failure result is explicit');
  assert(report.storageProbe.cleanup.some((entry) => entry.status === 'failed'), 'cleanup failure recorded');
  assert([...fakeHost.state.users['recursion-soak-a'].files.keys()].length > 0, 'test simulates leaked probe file on cleanup failure');
}

{
  const report = await runSillyTavernLiveSmoke({
    argv: [],
    env: {}
  });
  assertEqual(report.status, 'skipped', 'live smoke with no user is a dry-run checklist');
  assert(report.checks.some((check) => check.name === 'dedicated-user-policy' && check.status === 'skipped'), 'missing smoke user is skipped in dry-run mode');
}

{
  const report = await runSillyTavernLiveSmoke({
    argv: ['--live'],
    env: {
      RECURSION_SILLYTAVERN_USER: 'default-user',
      SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000'
    }
  });
  assertEqual(report.status, 'unsafe-user', 'live smoke rejects default-user');
  assert(!report.checks.some((check) => check.name === 'browser-live-smoke'), 'unsafe user stops before browser smoke');
}

{
  const report = await runSillyTavernLiveSmoke({
    argv: [],
    env: {
      RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
      SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000'
    }
  });
  assertEqual(report.status, 'skipped', 'live smoke dry run is skipped');
  assertEqual(report.user, 'recursion-soak-a', 'dry run records safe user');
}

{
  const report = await runSillyTavernLiveSmoke({
    argv: ['--live', '--dry-run'],
    env: {
      RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
      SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000'
    }
  });
  assertEqual(report.status, 'skipped', 'dry-run overrides live flag');
  assertEqual(report.mode, 'dry-run', 'dry-run override reports dry-run mode');
  assertEqual(report.dryRun, true, 'dry-run override records dryRun true');
  assert(report.warnings.some((warning) => warning.name === 'dry-run-override'), 'dry-run override reports warning');
}

{
  const report = await runSillyTavernLiveSmoke({
    argv: ['--live', '--dry-run'],
    env: {
      RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
      SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000',
      RECURSION_LIVE_STRICT: '1'
    }
  });
  assertEqual(report.status, 'fail', 'strict mode promotes dry-run override warning to failure');
  assertEqual(report.result, 'strict-warning', 'strict warning result is explicit');
  assertEqual(report.dryRun, true, 'strict dry-run override still prevents live mutation');
  assertEqual(exitCodeForReport(report), 1, 'strict warning failure exits nonzero');
  assert(report.failures.some((failure) => failure.name === 'dry-run-override'), 'strict mode reports warning as failure');
}

{
  const report = await runSillyTavernLiveSmoke({
    argv: [],
    env: {
      RECURSION_LIVE_STRICT: '1'
    }
  });
  assertEqual(report.strict, true, 'RECURSION_LIVE_STRICT enables strict mode');
}

{
  const server = await createSillyTavernSmokeFixtureServer({ serveExtension: false });
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: server.baseUrl
      }
    });
    assertEqual(report.status, 'environment-fail', 'live smoke fails when served Recursion files are unavailable');
    assertEqual(report.result, 'served-extension-unavailable', 'missing served extension result is explicit');
    assert(!report.browser, 'browser smoke does not run when served extension is unavailable');
    assert(!report.storageProbe, 'storage probe does not run when served extension is unavailable');
    assertDeepEqual([...server.users['recursion-soak-a'].files.keys()], [], 'served extension failure writes no probe files');
    assert(report.checks.some((check) => check.name === 'sillytavern-auth' && check.status === 'pass'), 'auth gate passes before served extension failure');
    assert(report.checks.some((check) => check.name === 'served-extension-freshness' && check.status === 'environment-fail'), 'served extension failure is recorded');
  } finally {
    await server.close();
  }
}

{
  const server = await createSillyTavernSmokeFixtureServer({ mismatchManifest: true });
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: server.baseUrl,
        RECURSION_CONFIRM_EXTENSION_SYNCED: '1'
      }
    });
    assertEqual(report.status, 'stale-extension', 'served extension mismatch blocks live smoke even with operator confirmation');
    assertEqual(report.result, 'served-extension-mismatch', 'served mismatch result is explicit');
    assert(!report.browser, 'browser smoke does not run when served extension mismatch is detected');
    assert(!report.storageProbe, 'storage probe does not run when served extension mismatch is detected');
    assertDeepEqual([...server.users['recursion-soak-a'].files.keys()], [], 'served mismatch writes no probe files');
  } finally {
    await server.close();
  }
}

{
  const server = await createSillyTavernSmokeFixtureServer({ staleModule: 'src/runtime.mjs' });
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: server.baseUrl
      }
    });
    assertEqual(report.status, 'stale-extension', 'stale imported runtime module blocks live smoke');
    assertEqual(report.result, 'served-extension-mismatch', 'stale imported module reports served mismatch');
    assert(report.extension.compared.some((entry) => entry.relativePath === 'src/runtime.mjs' && entry.matches === false), 'served freshness checks imported runtime module');
    assert(report.extension.compared.some((entry) => entry.relativePath === 'src/hosts/sillytavern/storage.mjs'), 'served freshness checks nested host imports');
    assert(!report.browser, 'browser smoke does not run when imported module is stale');
    assert(!report.storageProbe, 'storage probe does not run when imported module is stale');
    assertDeepEqual([...server.users['recursion-soak-a'].files.keys()], [], 'stale imported module writes no probe files');
  } finally {
    await server.close();
  }
}

{
  const server = await createSillyTavernSmokeFixtureServer();
  const artifactRoot = mkdtempSync(join(tmpdir(), 'recursion-live-smoke-'));
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live', '--write-artifacts'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: server.baseUrl
      },
      artifactRoot
    });
    assertEqual(report.status, 'pass', 'live browser smoke passes against authenticated fixture');
    assertEqual(report.result, 'browser-smoke-pass', 'live browser smoke result is explicit');
    assertEqual(report.extension.servedStatus, 'served-extension-match', 'live smoke compares served Recursion files');
    assertEqual(report.storageProbe.status, 'pass', 'live smoke runs storage probe before browser smoke');
    assertEqual(report.browser.status, 'pass', 'browser result is pass');
    assertEqual(report.browser.snapshot.rootMounted, true, 'browser smoke sees Recursion root');
    assertEqual(report.browser.snapshot.statusText, 'Off', 'browser smoke reads disabled power state separately');
    assertEqual(report.browser.snapshot.modeText, 'Manual', 'browser smoke reads mode chip separately');
    assertEqual(report.browser.snapshot.handOpen, true, 'browser smoke opens hand dropdown');
    assertEqual(report.browser.snapshot.progressOpen, true, 'browser smoke opens progress popover');
    assertEqual(report.browser.snapshot.actionMenuOpen, false, 'browser smoke sees no legacy action menu');
    assertEqual(report.browser.snapshot.settingsPanelOpen, true, 'browser smoke opens settings panel');
    assertEqual(report.browser.snapshot.providerTestVisible, true, 'browser smoke sees provider test control');
    assertEqual(report.browser.snapshot.viewerOpened, true, 'browser smoke proves full viewer can open');
    assertEqual(report.browser.snapshot.viewerOpen, false, 'browser smoke closes full viewer before screenshots');
    assertEqual(report.browser.snapshot.bridge.interceptor, true, 'browser smoke sees Recursion generation bridge');
    assertEqual(report.browser.snapshot.bridge.enableHook, true, 'browser smoke sees Recursion enable hook');
    assertEqual(report.browser.snapshot.bridge.disableHook, true, 'browser smoke sees Recursion disable hook');
    assertEqual(report.browser.snapshot.modeSmoke?.ok, true, 'browser smoke proves disabled/Auto/Manual/disabled flow');
    assertDeepEqual(report.browser.snapshot.modeSmoke?.sequence, ['disabled', 'auto', 'manual', 'disabled'], 'mode smoke records exact mode sequence');
    assertEqual(report.browser.snapshot.modeSmoke?.steps.at(0)?.promptCleared, true, 'initial disabled power state clears seeded Recursion prompt');
    assertEqual(report.browser.snapshot.modeSmoke?.steps.at(-1)?.promptCleared, true, 'final disabled power state leaves Recursion prompts clear');
    assertEqual(report.artifacts.liveLog, 'live-log.jsonl', 'live smoke writes live log path');
    assertEqual(report.artifacts.servedExtension, 'host-extensions/served-extension-compare.json', 'live smoke writes served extension compare path');
    assertEqual(report.artifacts.storageProbe, 'storage/probe.json', 'live smoke writes storage probe path');
    assertEqual(report.artifacts.browserSnapshot, 'browser/snapshot.json', 'live smoke writes browser snapshot path');
    assertEqual(report.artifacts.promptMetadata, 'prompt/latest-packet-metadata.json', 'live smoke writes prompt metadata path');
    assertEqual(report.artifacts.activityLatestRun, 'activity/latest-run.json', 'live smoke writes activity latest-run path');
    assertEqual(report.artifacts.redactionCheck, 'diagnostics/redaction-check.json', 'live smoke writes redaction check path');
    assertEqual(report.artifacts.desktopScreenshot, 'screenshots/desktop.png', 'live smoke writes desktop screenshot path');
    assertEqual(report.artifacts.phoneScreenshot, 'screenshots/phone.png', 'live smoke writes phone screenshot path');
    assertEqual(report.artifacts.trace, 'playwright/trace.zip', 'live smoke writes trace path');
    const runRoot = join(artifactRoot, 'live-smoke', 'sillytavern', report.runId);
    assert(readFileSync(join(runRoot, 'report.json'), 'utf8').includes('"browser-smoke-pass"'), 'live smoke report persisted');
    assert(readFileSync(join(runRoot, 'live-log.jsonl'), 'utf8').includes('"browser-ui"'), 'live smoke log persisted');
    assert(readFileSync(join(runRoot, 'host-extensions', 'served-extension-compare.json'), 'utf8').includes('"served-extension-match"'), 'served extension artifact persisted');
    assert(readFileSync(join(runRoot, 'storage', 'probe.json'), 'utf8').includes('"storage-probe-pass"'), 'storage probe artifact persisted');
    assert(readFileSync(join(runRoot, 'browser', 'snapshot.json'), 'utf8').includes('"rootMounted": true'), 'browser snapshot artifact persisted');
    assert(readFileSync(join(runRoot, 'prompt', 'latest-packet-metadata.json'), 'utf8').includes('"available": false'), 'no-generation prompt metadata artifact persisted');
    assert(readFileSync(join(runRoot, 'activity', 'latest-run.json'), 'utf8').includes('"browser-smoke-pass"'), 'activity latest-run artifact persisted');
    assert(readFileSync(join(runRoot, 'diagnostics', 'redaction-check.json'), 'utf8').includes('"status": "pass"'), 'redaction check artifact persisted');
    assert(readFileSync(join(runRoot, 'screenshots', 'desktop.png')).length > 0, 'live smoke desktop screenshot written');
    assert(readFileSync(join(runRoot, 'screenshots', 'phone.png')).length > 0, 'live smoke phone screenshot written');
    assert(readFileSync(join(runRoot, 'playwright', 'trace.zip')).length > 0, 'live smoke trace written');
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    await server.close();
  }
}

{
  const server = await createSillyTavernSmokeFixtureServer({ staleModeChip: true });
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: server.baseUrl,
        RECURSION_LIVE_TIMEOUT_MS: '1000'
      }
    });
    assertEqual(report.status, 'fail', 'live browser smoke fails when mode chip is stale');
    assertEqual(report.result, 'browser-mode-smoke-failed', 'stale mode chip failure uses mode smoke result');
    assertEqual(report.browser.snapshot.modeSmoke?.ok, false, 'stale mode chip does not pass via context or select fallback');
  } finally {
    await server.close();
  }
}

{
  const server = await createSillyTavernSmokeFixtureServer({ omitVisibleSendMarker: true });
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: server.baseUrl,
        RECURSION_LIVE_GENERATION: '1'
      }
    });
    assertEqual(report.status, 'pass', 'visible send smoke passes from prompt evidence without fixture-only completion marker');
    assertEqual(report.browser.snapshot.generation.triggerSource, 'ui-send', 'markerless visible send still records ui-send trigger');
    assertEqual(report.browser.snapshot.generation.visibleSend.ok, true, 'markerless visible send is inferred from prompt evidence');
    assertEqual(report.browser.snapshot.generation.hostGenerationContinued, true, 'markerless visible send proves host generation continued');
  } finally {
    await server.close();
  }
}

{
  const server = await createSillyTavernSmokeFixtureServer({ visibleSendButtonClicksIgnored: true });
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: server.baseUrl,
        RECURSION_LIVE_GENERATION: '1'
      }
    });
    assertEqual(report.status, 'pass', 'visible send smoke retries with Enter when first click is ignored');
    assertEqual(report.browser.snapshot.generation.triggerSource, 'ui-send', 'retry still records visible send trigger');
    assert(
      report.browser.snapshot.generation.visibleSend.inputMethod.includes('keyboard-enter'),
      `visible send retry records keyboard-enter activation: ${JSON.stringify(report.browser.snapshot.generation.visibleSend)}`
    );
    assertEqual(report.browser.snapshot.generation.visibleSend.acceptedAfter, 'keyboard-enter', 'visible send retry records accepted activation method');
    assert(report.browser.snapshot.generation.visibleSend.inputValueLength > 0, 'visible send retry records input value length');
    assertEqual(report.browser.snapshot.generation.visibleSend.activationAttempts.length, 2, 'visible send retry records each activation attempt before success');
    assertEqual(report.browser.snapshot.generation.hostGenerationContinued, true, 'visible send retry proves host generation continued');
  } finally {
    await server.close();
  }
}

{
  const server = await createSillyTavernSmokeFixtureServer({ storyChatAvailable: true });
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: server.baseUrl,
        RECURSION_LIVE_GENERATION: '1',
        RECURSION_LIVE_CHARACTER_NAME: 'Story',
        RECURSION_LIVE_CHAT_FILE: 'Branch #790 - 2025-08-28@18h02m24s'
      }
    });
    assertEqual(report.status, 'pass', 'seeded story chat live smoke passes');
    assertEqual(report.browser.snapshot.seedChat?.status, 'pass', 'seeded story chat is selected before generation');
    assertEqual(report.browser.snapshot.seedChat?.characterName, 'Story', 'seeded story chat records selected character');
    assertEqual(report.browser.snapshot.seedChat?.chatFile, 'Branch #790 - 2025-08-28@18h02m24s', 'seeded story chat records selected chat file');
    assert(report.browser.snapshot.seedChat?.chatLength >= 3, 'seeded story chat loads existing story messages');
    assertEqual(report.browser.snapshot.generation.hostGenerationEvidence.chatLengthBefore, 3, 'generation starts from seeded story chat');
  } finally {
    await server.close();
  }
}

{
  const server = await createSillyTavernSmokeFixtureServer({ sendSurface: 'input-only' });
  const artifactRoot = mkdtempSync(join(tmpdir(), 'recursion-partial-send-smoke-'));
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live', '--write-artifacts'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: server.baseUrl,
        RECURSION_LIVE_GENERATION: '1'
      },
      artifactRoot
    });
    assertEqual(report.status, 'fail', 'partial visible send surface fails instead of falling back to direct bridge');
    assertEqual(report.result, 'generation-visible-send-unavailable', 'partial visible send reports explicit result');
    assertEqual(report.browser.snapshot.generation.triggerSource, 'ui-send', 'partial visible send failure records attempted trigger source');
    assertEqual(report.browser.snapshot.generation.visibleSend.inputFound, true, 'partial visible send records input presence');
    assertEqual(report.browser.snapshot.generation.visibleSend.buttonFound, false, 'partial visible send records missing button');
    const runRoot = join(artifactRoot, 'live-smoke', 'sillytavern', report.runId);
    const promptMetadata = readFileSync(join(runRoot, 'prompt', 'latest-packet-metadata.json'), 'utf8');
    assert(promptMetadata.includes('"triggerSource": "ui-send"'), 'partial send failure prompt metadata keeps trigger source');
    assert(promptMetadata.includes('"generationRequested": true'), 'partial send failure prompt metadata records requested generation');
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    await server.close();
  }
}

{
  const server = await createSillyTavernSmokeFixtureServer({ sendControlsDisabled: true });
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: server.baseUrl,
        RECURSION_LIVE_GENERATION: '1'
      }
    });
    assertEqual(report.status, 'fail', 'disabled visible send controls fail instead of falling back to direct bridge');
    assertEqual(report.result, 'generation-visible-send-unavailable', 'disabled visible send controls report explicit result');
    assertEqual(report.browser.snapshot.generation.triggerSource, 'ui-send', 'disabled visible send failure records ui-send trigger');
    assertEqual(report.browser.snapshot.generation.visibleSend.inputFound, true, 'disabled visible send records input presence');
    assertEqual(report.browser.snapshot.generation.visibleSend.buttonFound, true, 'disabled visible send records button presence');
    assertEqual(report.browser.snapshot.generation.visibleSend.inputUsable, false, 'disabled visible send records unusable input');
    assertEqual(report.browser.snapshot.generation.visibleSend.buttonUsable, false, 'disabled visible send records unusable button');
  } finally {
    await server.close();
  }
}

{
  const server = await createSillyTavernSmokeFixtureServer({ sendSurface: 'none' });
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: server.baseUrl,
        RECURSION_LIVE_GENERATION: '1'
      }
    });
    assertEqual(report.status, 'pass', 'no visible send controls use the recorded direct bridge fallback');
    assertEqual(report.browser.snapshot.generation.triggerSource, 'direct-bridge', 'no-control fallback records direct bridge trigger');
    assertEqual(report.browser.snapshot.generation.chatMutationSource, 'context-chat', 'no-control fallback records context chat mutation');
    assertEqual(report.browser.snapshot.generation.hostGenerationContinued, null, 'direct bridge fallback does not claim host continuation');
    assertEqual(report.browser.snapshot.generation.visibleSend.inputFound, false, 'direct bridge fallback records missing input');
    assertEqual(report.browser.snapshot.generation.visibleSend.buttonFound, false, 'direct bridge fallback records missing button');
  } finally {
    await server.close();
  }
}

{
  const server = await createSillyTavernSmokeFixtureServer();
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: server.baseUrl,
        RECURSION_LIVE_GENERATION: '1',
        RECURSION_LIVE_DIRECT_RECURSION_ONLY: '1'
      }
    });
    assertEqual(report.status, 'pass', 'forced direct Recursion smoke passes without visible host send');
    assertEqual(report.browser.snapshot.generation.triggerSource, 'direct-bridge', 'forced direct Recursion smoke records direct bridge trigger');
    assertEqual(report.browser.snapshot.generation.chatMutationSource, 'context-chat', 'forced direct Recursion smoke records context chat mutation');
    assertEqual(report.browser.snapshot.generation.visibleSend.inputFound, true, 'forced direct Recursion smoke still records visible input presence');
    assertEqual(report.browser.snapshot.generation.hostGenerationContinued, null, 'forced direct Recursion smoke does not claim host continuation');
  } finally {
    await server.close();
  }
}

{
  const server = await createSillyTavernSmokeFixtureServer({ directBridgeNeverResolves: true });
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: server.baseUrl,
        RECURSION_LIVE_GENERATION: '1',
        RECURSION_LIVE_DIRECT_RECURSION_ONLY: '1',
        RECURSION_LIVE_TIMEOUT_MS: '1000'
      }
    });
    assertEqual(report.status, 'fail', 'forced direct Recursion smoke fails when bridge never resolves');
    assertEqual(report.result, 'generation-direct-bridge-timeout', 'forced direct Recursion smoke timeout uses explicit result');
    assertEqual(report.browser.snapshot.generation.triggerSource, 'direct-bridge', 'direct bridge timeout preserves trigger source');
    assert(/timed out/i.test(report.browser.snapshot.generation.interceptorError || ''), 'direct bridge timeout records timeout error');
  } finally {
    await server.close();
  }
}

{
  const server = await createSillyTavernSmokeFixtureServer({ sendSurface: 'none' });
  const artifactRoot = mkdtempSync(join(tmpdir(), 'recursion-strict-direct-bridge-smoke-'));
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live', '--write-artifacts', '--strict'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: server.baseUrl,
        RECURSION_LIVE_GENERATION: '1'
      },
      artifactRoot
    });
    assertEqual(report.status, 'fail', 'strict generation smoke rejects direct bridge diagnostic fallback');
    assertEqual(report.result, 'generation-direct-bridge-diagnostic', 'strict direct bridge failure uses explicit result');
    assertEqual(report.browser.snapshot.generation.triggerSource, 'direct-bridge', 'strict direct bridge failure preserves trigger source');
    assert(report.checks.some((check) => check.name === 'generation-live-smoke' && check.status === 'fail'), 'strict direct bridge records failing generation check');
    const runRoot = join(artifactRoot, 'live-smoke', 'sillytavern', report.runId);
    const promptMetadata = readFileSync(join(runRoot, 'prompt', 'latest-packet-metadata.json'), 'utf8');
    assert(promptMetadata.includes('"triggerSource": "direct-bridge"'), 'strict direct bridge prompt metadata records trigger source');
    assert(promptMetadata.includes('"result": "generation-direct-bridge-diagnostic"'), 'strict direct bridge prompt metadata records release-proof failure');
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    await server.close();
  }
}

{
  const server = await createSillyTavernSmokeFixtureServer({ omitHostGenerationContinuation: true });
  const artifactRoot = mkdtempSync(join(tmpdir(), 'recursion-host-continuation-smoke-'));
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live', '--write-artifacts'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: server.baseUrl,
        RECURSION_LIVE_GENERATION: '1'
      },
      artifactRoot
    });
    assertEqual(report.status, 'fail', 'visible send fails when host generation does not continue after prompt install');
    assertEqual(report.result, 'generation-host-continuation-failed', 'missing host continuation reports explicit result');
    assertEqual(/screenshot/i.test(report.nextAction || ''), false, 'generation failure guidance does not ask for suppressed screenshots');
    assertEqual(report.browser.snapshot.generation.triggerSource, 'ui-send', 'host continuation failure records visible trigger source');
    assertEqual(report.browser.snapshot.generation.hostGenerationContinued, false, 'host continuation failure records missing continuation');
    assertEqual(report.browser.snapshot.generation.promptInstalled, true, 'host continuation failure keeps prompt-install evidence');
    const runRoot = join(artifactRoot, 'live-smoke', 'sillytavern', report.runId);
    const promptMetadata = readFileSync(join(runRoot, 'prompt', 'latest-packet-metadata.json'), 'utf8');
    assert(promptMetadata.includes('"hostGenerationContinued": false'), 'host continuation failure prompt metadata records missing continuation');
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    await server.close();
  }
}

{
  const server = await createSillyTavernSmokeFixtureServer({ ignorePromptClear: true });
  const artifactRoot = mkdtempSync(join(tmpdir(), 'recursion-clear-fail-smoke-'));
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live', '--write-artifacts'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: server.baseUrl,
        RECURSION_LIVE_GENERATION: '1'
      },
      artifactRoot
    });
    assertEqual(report.status, 'fail', 'generation smoke fails when host prompt state remains uncleared');
    assertEqual(report.result, 'generation-smoke-clear-failed', 'uncleared host prompt state reports clear failure');
    assertEqual(report.browser.cleanup?.promptCleared, false, 'clear failure browser result keeps cleanup evidence');
    const runRoot = join(artifactRoot, 'live-smoke', 'sillytavern', report.runId);
    const promptMetadata = readFileSync(join(runRoot, 'prompt', 'latest-packet-metadata.json'), 'utf8');
    const activityRun = readFileSync(join(runRoot, 'activity', 'latest-run.json'), 'utf8');
    assert(promptMetadata.includes('"generationRequested": true'), 'clear failure prompt metadata records generation was requested');
    assert(promptMetadata.includes('"clearStatus": "not-cleared"'), 'clear failure prompt metadata records not-cleared status');
    assert(activityRun.includes('"generation-smoke-clear-failed"'), 'clear failure activity artifact records clear failure result');
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    await server.close();
  }
}

{
  const server = await createSillyTavernSmokeFixtureServer();
  const artifactRoot = mkdtempSync(join(tmpdir(), 'recursion-generation-smoke-'));
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live', '--write-artifacts'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: server.baseUrl,
        RECURSION_LIVE_GENERATION: '1'
      },
      artifactRoot
    });
    assertEqual(report.status, 'pass', 'generation-enabled smoke passes when prompt bridge proof succeeds');
    assertEqual(report.result, 'generation-smoke-pass', 'generation-enabled smoke result is explicit');
    assertEqual(report.browser.status, 'pass', 'generation smoke still proves browser UI preflight');
    assertEqual(report.browser.snapshot.generation.triggerSource, 'ui-send', 'generation smoke uses visible send controls when available');
    assertEqual(report.browser.snapshot.generation.chatMutationSource, 'visible-control', 'generation smoke records visible chat mutation source');
    assertEqual(report.browser.snapshot.generation.hostGenerationContinued, true, 'generation smoke proves host generation continued after visible send');
    assertEqual(report.browser.snapshot.generation.manualProof?.ok, true, 'generation smoke proves Manual mode before Auto');
    assertEqual(report.browser.snapshot.generation.manualProof?.promptInstalled, true, 'Manual proof records prompt install');
    assertEqual(report.browser.snapshot.generation.manualScopeProof?.available, true, 'generation smoke finds Manual card scope controls');
    assertEqual(report.browser.snapshot.generation.manualScopeProof?.disabledFamily, 'Active Cast', 'Manual scope proof records disabled family');
    assertEqual(report.browser.snapshot.generation.manualScopeProof?.disabled, true, 'Manual scope proof narrows the card scope');
    assertEqual(report.browser.snapshot.generation.manualScopeProof?.promptRespectsDisabledFamily, true, 'Manual scope proof shows disabled family absent from selected prompt refs');
    assertEqual(report.browser.snapshot.generation.manualForcedProof?.available, true, 'generation smoke finds Manual forced controls');
    assertEqual(report.browser.snapshot.generation.manualForcedProof?.capBlocked, true, 'manual forced proof records cap block');
    assertDeepEqual(report.browser.snapshot.generation.manualForcedProof?.coveredFamilies, ['Scene Frame', 'Open Threads'], 'manual forced proof records covered selected families');
    assertEqual(/screenshot/i.test(report.nextAction || ''), false, 'generation success guidance does not ask for suppressed screenshots');
    assertEqual(report.browser.snapshot.generation.promptInstalled, true, 'generation smoke records Recursion prompt install');
    assertEqual(report.browser.cleanup?.promptCleared, true, 'generation smoke records Recursion prompt clear');
    assertEqual(report.browser.snapshot.generation.handReady, true, 'generation smoke records a composed hand');
    assertEqual(report.browser.snapshot.generation.promptPacketVisible, true, 'generation smoke sees prompt packet metadata');
    assert(report.checks.some((check) => check.name === 'generation-live-smoke' && check.status === 'pass'), 'generation smoke check records pass status');
    assertEqual(report.artifacts.promptMetadata, 'prompt/latest-packet-metadata.json', 'generation smoke writes prompt metadata artifact path');
    assertEqual(report.artifacts.activityLatestRun, 'activity/latest-run.json', 'generation smoke writes activity artifact path');
    assertEqual(report.artifacts.redactionCheck, 'diagnostics/redaction-check.json', 'generation smoke writes redaction check artifact path');
    assertEqual(Boolean(report.artifacts.desktopScreenshot), false, 'generation smoke does not write desktop screenshot artifacts');
    assertEqual(Boolean(report.artifacts.phoneScreenshot), false, 'generation smoke does not write phone screenshot artifacts');
    assertEqual(Boolean(report.artifacts.trace), false, 'generation smoke does not write Playwright trace artifacts');
    const runRoot = join(artifactRoot, 'live-smoke', 'sillytavern', report.runId);
    const promptMetadata = readFileSync(join(runRoot, 'prompt', 'latest-packet-metadata.json'), 'utf8');
    const activityRun = readFileSync(join(runRoot, 'activity', 'latest-run.json'), 'utf8');
    const redactionCheck = readFileSync(join(runRoot, 'diagnostics', 'redaction-check.json'), 'utf8');
    assertEqual(existsSync(join(runRoot, 'screenshots', 'desktop.png')), false, 'generation smoke omits desktop screenshot file');
    assertEqual(existsSync(join(runRoot, 'screenshots', 'phone.png')), false, 'generation smoke omits phone screenshot file');
    assertEqual(existsSync(join(runRoot, 'playwright', 'trace.zip')), false, 'generation smoke omits Playwright trace file');
    assert(promptMetadata.includes('"available": true'), 'generation prompt metadata records availability');
    assert(promptMetadata.includes('"packet-smoke"'), 'generation prompt metadata records packet id');
    assert(promptMetadata.includes('"installStatus": "installed"'), 'generation prompt metadata records install status');
    assert(promptMetadata.includes('"clearStatus": "cleared"'), 'generation prompt metadata records clear status');
    assert(promptMetadata.includes('"triggerSource": "ui-send"'), 'generation prompt metadata records visible trigger source');
    assert(promptMetadata.includes('"hostGenerationContinued": true'), 'generation prompt metadata records host continuation');
    assert(promptMetadata.includes('"manualProof"'), 'generation prompt metadata records Manual proof');
    assert(promptMetadata.includes('"manualScopeProof"'), 'generation prompt metadata records Manual scope proof');
    assert(promptMetadata.includes('"manualForcedProof"'), 'generation prompt metadata records Manual forced proof');
    assert(promptMetadata.includes('"capBlocked": true'), 'generation prompt metadata records Manual cap block');
    assert(promptMetadata.includes('"promptRespectsDisabledFamily": true'), 'generation prompt metadata records disabled family absence');
    assert(promptMetadata.includes('"mode": "manual"'), 'generation prompt metadata records Manual mode');
    assert(promptMetadata.includes('"promptInstalled": true'), 'generation prompt metadata records Manual injection');
    assert(promptMetadata.includes('"promptKeys"'), 'generation prompt metadata records prompt keys');
    assert(activityRun.includes('"generation-smoke-pass"'), 'generation activity latest-run records generation result');
    assert(redactionCheck.includes('"status": "pass"'), 'generation redaction check passes');
    assert(!promptMetadata.includes('Recursion smoke scene brief'), 'prompt metadata artifact omits raw prompt text');
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    await server.close();
  }
}

{
  const server = await createSillyTavernSmokeFixtureServer({ manualSkipsPrompt: true });
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: server.baseUrl,
        RECURSION_LIVE_GENERATION: '1',
        RECURSION_LIVE_TIMEOUT_MS: '1000'
      }
    });
    assertEqual(report.status, 'fail', 'generation smoke fails if Manual does not install prompt text before Auto');
    assertEqual(report.result, 'generation-manual-install-failed', 'Manual install failure result is explicit');
    assertEqual(report.browser.snapshot.generation.manualProof?.ok, false, 'Manual failure records failed proof');
    assertEqual(report.browser.snapshot.generation.manualProof?.promptInstalled, false, 'Manual failure records missing prompt install');
  } finally {
    await server.close();
  }
}

{
  const server = await createSillyTavernSmokeFixtureServer({ manualInterceptorNeverResolves: true });
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: server.baseUrl,
        RECURSION_LIVE_GENERATION: '1',
        RECURSION_LIVE_DIRECT_RECURSION_ONLY: '1',
        RECURSION_LIVE_TIMEOUT_MS: '1000'
      }
    });
    assertEqual(report.status, 'pass', 'generation smoke proceeds when Manual prompt evidence appears before interceptor settles');
    assertEqual(report.result, 'generation-smoke-pass', 'Manual stalled interceptor with prompt evidence still completes generation smoke');
    assertEqual(report.browser.snapshot.generation.manualProof?.ok, true, 'Manual proof accepts prompt evidence without interceptor settlement');
    assertEqual(report.browser.snapshot.generation.manualProof?.promptInstalled, true, 'Manual proof records installed prompt evidence');
  } finally {
    await server.close();
  }
}

{
  const server = await createSillyTavernSmokeFixtureServer({ unclearedPromptOnDisable: true });
  const artifactRoot = mkdtempSync(join(tmpdir(), 'recursion-manual-baseline-fail-'));
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live', '--write-artifacts'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: server.baseUrl,
        RECURSION_LIVE_GENERATION: '1',
        RECURSION_LIVE_TIMEOUT_MS: '1000'
      },
      artifactRoot
    });
    assertEqual(report.status, 'fail', 'generation smoke fails if Manual baseline prompt remains installed');
    assertEqual(report.result, 'generation-manual-install-failed', 'uncleared Manual baseline uses explicit failure result');
    assertEqual(report.browser.snapshot.generation.manualProof?.baselineClearOk, false, 'Manual proof records failed baseline clear');
    assertEqual(report.browser.snapshot.generation.manualProof?.promptInstalled, true, 'Manual proof records remaining prompt install');
    const runRoot = join(artifactRoot, 'live-smoke', 'sillytavern', report.runId);
    const promptMetadata = readFileSync(join(runRoot, 'prompt', 'latest-packet-metadata.json'), 'utf8');
    const activityRun = readFileSync(join(runRoot, 'activity', 'latest-run.json'), 'utf8');
    const redactionCheck = readFileSync(join(runRoot, 'diagnostics', 'redaction-check.json'), 'utf8');
    assert(promptMetadata.includes('"manualProof"'), 'Manual baseline failure writes proof metadata');
    assert(promptMetadata.includes('"baselineClearOk": false'), 'Manual baseline failure metadata records failed clear');
    assert(activityRun.includes('"generation-manual-install-failed"'), 'Manual baseline failure activity records result');
    assert(redactionCheck.includes('"status": "pass"'), 'Manual baseline failure artifacts pass redaction');
    assertEqual(existsSync(join(runRoot, 'screenshots', 'desktop.png')), false, 'Manual baseline failure omits desktop screenshot');
    assertEqual(existsSync(join(runRoot, 'playwright', 'trace.zip')), false, 'Manual baseline failure omits trace');
    assert(!promptMetadata.includes('Recursion stale disabled baseline prompt'), 'Manual baseline failure omits raw prompt text');
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    await server.close();
  }
}

{
  const server = await createSillyTavernSmokeFixtureServer({ disableHookNeverResolves: true });
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: server.baseUrl,
        RECURSION_LIVE_GENERATION: '1',
        RECURSION_LIVE_DIRECT_RECURSION_ONLY: '1',
        RECURSION_LIVE_TIMEOUT_MS: '1000'
      }
    });
    assertEqual(report.status, 'pass', 'generation smoke passes when prompt cleanup clears prompts before hook promise stalls');
    assertEqual(report.result, 'generation-smoke-pass', 'prompt cleanup success does not wait for stalled hook promise');
    assertEqual(report.browser.cleanup?.promptCleared, true, 'prompt cleanup records cleared status from prompt evidence');
    assertEqual(report.browser.cleanup?.disableHookOk, true, 'prompt cleanup records hook invocation success without waiting forever');
  } finally {
    await server.close();
  }
}

{
  const server = await createSillyTavernSmokeFixtureServer({ manualModeSave: 'noop' });
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: server.baseUrl,
        RECURSION_LIVE_GENERATION: '1',
        RECURSION_LIVE_TIMEOUT_MS: '1000'
      }
    });
    assertEqual(report.status, 'fail', 'generation smoke fails when Manual mode does not apply');
    assertEqual(report.result, 'generation-manual-mode-unavailable', 'Manual mode no-op save failure result is explicit');
    assertEqual(report.browser.snapshot.generation.manualProof?.ok, false, 'Manual mode no-op records failed proof');
  } finally {
    await server.close();
  }
}

{
  const server = await createSillyTavernSmokeFixtureServer({ manualModeSave: 'async' });
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: server.baseUrl,
        RECURSION_LIVE_GENERATION: '1'
      }
    });
    assertEqual(report.status, 'pass', 'generation smoke waits for asynchronous Manual mode application');
    assertEqual(report.browser.snapshot.generation.manualProof?.observedMode, 'manual', 'async Manual proof records observed mode');
  } finally {
    await server.close();
  }
}

{
  const server = await createSillyTavernSmokeFixtureServer();
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: server.baseUrl,
        RECURSION_LIVE_REASONER: '1'
      }
    });
    assertEqual(report.status, 'fail', 'Reasoner smoke fails when prompt composition skips Reasoner');
    assertEqual(report.result, 'generation-reasoner-not-exercised', 'Reasoner skipped result is explicit');
    assertEqual(report.browser.snapshot.generation.promptPacket?.diagnostics?.reasonerStatus, 'skipped', 'skipped packet diagnostics are preserved');
  } finally {
    await server.close();
  }
}

{
  const server = await createSillyTavernSmokeFixtureServer({ reasonerFallback: true });
  const artifactRoot = mkdtempSync(join(tmpdir(), 'recursion-reasoner-fallback-smoke-'));
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live', '--write-artifacts'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: server.baseUrl,
        RECURSION_LIVE_REASONER: '1'
      },
      artifactRoot
    });
    assertEqual(report.status, 'pass', 'Reasoner fallback smoke still passes host generation');
    assertEqual(report.browser.snapshot.generation.reasonerRequested, true, 'Reasoner fallback smoke records Reasoner request');
    assertEqual(report.browser.snapshot.generation.promptPacket?.diagnostics?.reasonerStatus, 'fallback', 'Reasoner fallback smoke records fallback status');
    assertEqual(report.browser.snapshot.generation.promptPacket?.diagnostics?.composerLane, 'utility', 'Reasoner fallback smoke records Utility composition');
    assertEqual(report.browser.snapshot.generation.hostGenerationContinued, true, 'Reasoner fallback smoke proves host generation continued');
    const runRoot = join(artifactRoot, 'live-smoke', 'sillytavern', report.runId);
    const promptMetadata = readFileSync(join(runRoot, 'prompt', 'latest-packet-metadata.json'), 'utf8');
    assert(promptMetadata.includes('"reasonerStatus": "fallback"'), 'Reasoner fallback prompt metadata records fallback');
    assert(promptMetadata.includes('"composerLane": "utility"'), 'Reasoner fallback prompt metadata records Utility composer lane');
    assert(!promptMetadata.includes('reasoner raw failure text'), 'Reasoner fallback metadata omits raw provider error text');
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    await server.close();
  }
}

{
  const server = await createSillyTavernSmokeFixtureServer();
  const artifactRoot = mkdtempSync(join(tmpdir(), 'recursion-strict-live-smoke-'));
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live', '--write-artifacts', '--strict'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: server.baseUrl
      },
      artifactRoot
    });
    assertEqual(report.status, 'fail', 'strict live smoke promotes storage warning to final failure');
    assertEqual(report.result, 'strict-warning', 'strict live smoke final result is strict warning');
    const runRoot = join(artifactRoot, 'live-smoke', 'sillytavern', report.runId);
    const promptMetadata = readFileSync(join(runRoot, 'prompt', 'latest-packet-metadata.json'), 'utf8');
    const activityRun = readFileSync(join(runRoot, 'activity', 'latest-run.json'), 'utf8');
    assert(promptMetadata.includes('"status": "fail"'), 'prompt metadata records final strict failure status');
    assert(promptMetadata.includes('"result": "strict-warning"'), 'prompt metadata records final strict warning result');
    assert(activityRun.includes('"status": "fail"'), 'activity artifact records final strict failure status');
    assert(activityRun.includes('"strict-warning"'), 'activity artifact records final strict warning result');
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    await server.close();
  }
}

{
  const artifactRoot = mkdtempSync(join(tmpdir(), 'recursion-redaction-safe-'));
  try {
    const report = createBaseReport({ scriptName: 'redaction-safe', args: { live: true }, env: {} });
    setReportStatus(report, 'pass', 'safe-redacted-artifacts');
    const runRoot = join(artifactRoot, 'live-smoke', 'sillytavern', report.runId);
    mkdirSync(join(runRoot, 'diagnostics'), { recursive: true });
    writeFileSync(join(runRoot, 'diagnostics', 'safe-redacted.json'), JSON.stringify({
      authorization: '[redacted]',
      bearer: '[redacted]',
      password: '[redacted]',
      sessionId: '[redacted]',
      redactedFields: ['rawPrompt', 'rawResponse', 'providerPrompt', 'providerResponse']
    }, null, 2), 'utf8');
    const attached = attachReportArtifacts(report, { artifactRoot, family: 'live-smoke/sillytavern' });
    assertEqual(attached.status, 'pass', 'safely redacted generated artifact does not fail redaction scan');
    const redactionCheck = readFileSync(join(runRoot, 'diagnostics', 'redaction-check.json'), 'utf8');
    assert(redactionCheck.includes('"status": "pass"'), 'redaction check records pass for redacted keys and redactedFields list');
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
}

{
  const artifactRoot = mkdtempSync(join(tmpdir(), 'recursion-redaction-leak-'));
  try {
    const report = createBaseReport({ scriptName: 'redaction-leak', args: { live: true }, env: {} });
    setReportStatus(report, 'pass', 'unsafe-artifact');
    const runRoot = join(artifactRoot, 'live-smoke', 'sillytavern', report.runId);
    mkdirSync(join(runRoot, 'prompt'), { recursive: true });
    writeFileSync(join(runRoot, 'prompt', 'unsafe.json'), JSON.stringify({
      sessionApiKey: 'sk-live-secret',
      accessToken: 'plain-access-token',
      openaiApiKey: 'plain-openai-key',
      clientSecret: 'plain-client-secret',
      cookieHeader: 'plain-cookie-header',
      bearerToken: 'plain-bearer-token',
      authHeader: 'plain-auth-header',
      debugRawPrompt: 'visible raw prompt marker',
      note: 'rawPrompt outside redactedFields',
      privateKey: 'private-key-material',
      credentials: 'credential-secret',
      rawPrompt: 'raw prompt should not persist'
    }, null, 2), 'utf8');
    const attached = attachReportArtifacts(report, { artifactRoot, family: 'live-smoke/sillytavern' });
    assertEqual(attached.status, 'fail', 'unsafe generated artifact fails redaction scan');
    assertEqual(attached.result, 'artifact-redaction-failed', 'unsafe generated artifact reports redaction failure');
    const unsafeArtifact = readFileSync(join(runRoot, 'prompt', 'unsafe.json'), 'utf8');
    const redactionCheck = readFileSync(join(runRoot, 'diagnostics', 'redaction-check.json'), 'utf8');
    assert(unsafeArtifact.includes('recursion.artifactScrubbed'), 'unsafe text artifact is scrubbed in place');
    assert(!unsafeArtifact.includes('sk-live-secret'), 'unsafe artifact no longer contains leaked API key');
    assert(!unsafeArtifact.includes('private-key-material'), 'unsafe artifact no longer contains leaked private key');
    assert(!unsafeArtifact.includes('raw prompt should not persist'), 'unsafe artifact no longer contains raw prompt text');
    assert(redactionCheck.includes('"status": "fail"'), 'redaction check records failure');
    assert(redactionCheck.includes('prompt/unsafe.json'), 'redaction check records unsafe artifact path');
    assert(redactionCheck.includes('accessToken'), 'redaction check catches token suffix keys');
    assert(redactionCheck.includes('openaiApiKey'), 'redaction check catches api key suffix keys');
    assert(redactionCheck.includes('clientSecret'), 'redaction check catches secret suffix keys');
    assert(redactionCheck.includes('authHeader'), 'redaction check catches auth header keys');
    assert(redactionCheck.includes('debugRawPrompt'), 'redaction check catches raw prompt suffix keys');
    assert(redactionCheck.includes('note'), 'redaction check catches prompt-marker strings outside redactedFields');
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
}

{
  const artifactRoot = mkdtempSync(join(tmpdir(), 'recursion-redaction-report-'));
  try {
    const report = createBaseReport({ scriptName: 'redaction-report', args: { live: true }, env: {} });
    report.debug = {
      rawPrompt: 'raw prompt leaked through report',
      accessToken: 'plain-access-token'
    };
    setReportStatus(report, 'pass', 'unsafe-report');
    const attached = attachReportArtifacts(report, { artifactRoot, family: 'live-smoke/sillytavern' });
    assertEqual(attached.status, 'fail', 'unsafe report artifact fails redaction scan');
    assertEqual(attached.result, 'artifact-redaction-failed', 'unsafe report artifact reports redaction failure');
    const attachedText = JSON.stringify(attached);
    const runRoot = join(artifactRoot, 'live-smoke', 'sillytavern', report.runId);
    const persistedReport = readFileSync(join(runRoot, 'report.json'), 'utf8');
    const persistedSummary = readFileSync(join(runRoot, 'summary.md'), 'utf8');
    assert(!attachedText.includes('raw prompt leaked through report'), 'returned report does not re-leak raw prompt after scrub');
    assert(!attachedText.includes('plain-access-token'), 'returned report does not re-leak token after scrub');
    assert(!persistedReport.includes('raw prompt leaked through report'), 'final report does not re-leak raw prompt after scrub');
    assert(!persistedReport.includes('plain-access-token'), 'final report does not re-leak token after scrub');
    assert(!persistedSummary.includes('raw prompt leaked through report'), 'final summary does not re-leak raw prompt after scrub');
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
}

{
  const server = await createSillyTavernSmokeFixtureServer({ asyncUiGeneration: true });
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: server.baseUrl,
        RECURSION_LIVE_GENERATION: '1'
      }
    });
    assertEqual(report.status, 'pass', 'generation smoke waits for delayed UI-rendered prompt evidence');
    assertEqual(report.browser.snapshot.generation.promptPacketVisible, true, 'delayed UI prompt metadata is eventually observed');
  } finally {
    await server.close();
  }
}

{
  const server = await createSillyTavernSmokeFixtureServer({ omitPromptPacketMetadata: true });
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: server.baseUrl,
        RECURSION_LIVE_GENERATION: '1',
        RECURSION_LIVE_TIMEOUT_MS: '1000'
      }
    });
    assertEqual(report.status, 'fail', 'generation smoke fails without non-empty prompt packet metadata');
    assertEqual(report.result, 'generation-smoke-assertion-failed', 'missing packet metadata failure is explicit');
  } finally {
    await server.close();
  }
}

{
  const server = await createSillyTavernSmokeFixtureServer({ missingDisableHook: true });
  const artifactRoot = mkdtempSync(join(tmpdir(), 'recursion-live-smoke-fail-'));
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live', '--write-artifacts'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: server.baseUrl,
        RECURSION_LIVE_TIMEOUT_MS: '1000'
      },
      artifactRoot
    });
    assertEqual(report.status, 'fail', 'missing bridge hook fails live browser smoke');
    assertEqual(report.result, 'browser-smoke-timeout', 'missing bridge hook fails at bridge wait');
    assertEqual(report.storageProbe.status, 'pass', 'bridge failure happens after storage probe pass');
    assertEqual(report.browser.artifacts.failureScreenshot, 'screenshots/failure.png', 'failed browser smoke writes failure screenshot path');
    assertEqual(report.browser.artifacts.trace, 'playwright/trace.zip', 'failed browser smoke writes trace path');
    assertEqual(report.artifacts.failureScreenshot, 'screenshots/failure.png', 'failed live smoke promotes failure screenshot artifact');
    assertEqual(report.artifacts.trace, 'playwright/trace.zip', 'failed live smoke promotes trace artifact');
    const runRoot = join(artifactRoot, 'live-smoke', 'sillytavern', report.runId);
    assert(readFileSync(join(runRoot, 'screenshots', 'failure.png')).length > 0, 'failed live smoke screenshot written');
    assert(readFileSync(join(runRoot, 'playwright', 'trace.zip')).length > 0, 'failed live smoke trace written');
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    await server.close();
  }
}

{
  const report = await runPlaywrightReadiness({
    argv: ['--dry-run'],
    env: {}
  });
  assertEqual(report.status, 'skipped', 'playwright dry run skips browser launch');
  assert(report.checks.some((check) => check.name === 'sillytavern-contact' && check.status === 'pass'), 'readiness documents no SillyTavern contact');
}

{
  const artifactRoot = mkdtempSync(join(tmpdir(), 'recursion-readiness-'));
  try {
    const report = await runPlaywrightReadiness({
      argv: ['--write-artifacts'],
      env: {},
      artifactRoot
    });
    assertEqual(report.status, 'pass', 'real Playwright readiness passes');
    assertEqual(report.result, 'readiness-pass', 'real readiness result is explicit');
    assertDeepEqual(report.artifacts, {
      desktopScreenshot: 'screenshots/desktop.png',
      phoneScreenshot: 'screenshots/phone.png',
      trace: 'playwright/trace.zip',
      summary: 'summary.md',
      report: 'report.json'
    }, 'readiness artifact paths are relative to run root');
    const runRoot = join(artifactRoot, 'playwright-readiness', report.runId);
    const persisted = readFileSync(join(runRoot, 'report.json'), 'utf8');
    const summary = readFileSync(join(runRoot, 'summary.md'), 'utf8');
    assert(persisted.includes('"readiness-pass"'), 'readiness report persisted');
    assert(summary.includes('Playwright readiness passed'), 'readiness summary includes next action');
    assert(readFileSync(join(runRoot, 'screenshots', 'desktop.png')).length > 0, 'desktop screenshot written');
    assert(readFileSync(join(runRoot, 'screenshots', 'phone.png')).length > 0, 'phone screenshot written');
    assert(readFileSync(join(runRoot, 'playwright', 'trace.zip')).length > 0, 'trace written');
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
}

{
  const report = createBaseReport({ scriptName: 'redaction-check', args: {}, env: {} });
  addCheck(report, {
    name: 'secret-message',
    status: 'environment-fail',
    summary: 'Authorization: Bearer sk-live-secret and password=hunter2',
    details: {
      message: 'Provider returned Authorization: Bearer sk-live-secret with apiKey=abc123 and sessionId=sess-12345',
      sessionId: 'sess-field-12345',
      sid: 'sid-field-12345',
      sessionCount: 2
    }
  });
  setReportStatus(report, 'environment-fail', 'redaction-check');
  report.nextAction = 'Remove token=abc123, sid=nav-12345, and sk-live-secret from logs.';
  const finalized = finalizeReport(report);
  const serialized = JSON.stringify(finalized);
  const summary = reportToSummary(finalized);
  assert(!serialized.includes('sk-live-secret'), 'report redacts sk-style values inside strings');
  assert(!serialized.includes('abc123'), 'report redacts token-like values inside strings');
  assert(!serialized.includes('hunter2'), 'report redacts password-like values inside strings');
  assert(!serialized.includes('sess-12345'), 'report redacts sessionId-like values inside strings');
  assert(!serialized.includes('sess-field-12345'), 'report redacts sessionId fields');
  assert(!serialized.includes('sid-field-12345'), 'report redacts sid fields');
  assertEqual(finalized.checks[0].details.sessionCount, 2, 'sessionCount metrics are preserved');
  assert(!summary.includes('sk-live-secret'), 'summary redacts sk-style values');
  assert(!summary.includes('abc123'), 'summary redacts token-like values');
  assert(!summary.includes('nav-12345'), 'summary redacts sid-like values');
  assert(summary.includes('[redacted]'), 'summary keeps redaction marker');
}

{
  const report = createBaseReport({ scriptName: 'print-report-exit', args: {}, env: {} });
  setReportStatus(report, 'pass', 'print-report-pass');
  const writes = [];
  let observedExitCode = null;
  printReportAndSetExitCode(report, {
    stdout: { write: (chunk) => writes.push(String(chunk)) },
    exit: (code) => { observedExitCode = code; }
  });
  assert(writes.join('').includes('"print-report-pass"'), 'print report writes JSON before exiting');
  assertEqual(observedExitCode, 0, 'print report can force direct CLI exit after writing JSON');
}

{
  const artifactRoot = mkdtempSync(join(tmpdir(), 'recursion-harness-'));
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--write-artifacts'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000',
        RECURSION_ARTIFACT_DIR: artifactRoot,
        RECURSION_API_KEY: 'secret-value'
      },
      artifactRoot
    });
    assertEqual(report.status, 'skipped', 'artifact dry run is skipped');
    assertDeepEqual(report.artifacts, { summary: 'summary.md', report: 'report.json' }, 'artifact paths are relative to run root');
    const runRoot = join(artifactRoot, 'live-smoke', 'sillytavern', report.runId);
    const persisted = readFileSync(join(runRoot, 'report.json'), 'utf8');
    const summary = readFileSync(join(runRoot, 'summary.md'), 'utf8');
    assert(!persisted.includes('secret-value'), 'artifact report redacts environment secrets');
    assert(!persisted.includes(artifactRoot), 'artifact report does not store absolute artifact root');
    assert(persisted.includes('"recordType": "recursion.liveHarnessReport"'), 'artifact report uses live harness record type');
    assert(persisted.includes('"artifacts"'), 'persisted artifact report includes artifact metadata');
    assert(summary.includes('## Next Action'), 'summary includes next action section');
    assert(summary.includes('Re-run with --live to authenticate, compare served files, and check the Recursion UI with Playwright.'), 'summary includes actionable next step');
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
}

{
  const artifactRoot = mkdtempSync(join(tmpdir(), 'recursion-harness-'));
  try {
    const blockedRoot = join(artifactRoot, 'not-a-directory');
    writeFileSync(blockedRoot, 'file blocks artifact directory', 'utf8');
    const report = await runSillyTavernLiveSmoke({
      argv: ['--write-artifacts'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'recursion-soak-a',
        SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000'
      },
      artifactRoot: blockedRoot
    });
    assertEqual(report.status, 'environment-fail', 'artifact write failure returns environment-fail report');
    assertEqual(report.result, 'artifact-write-failed', 'artifact write failure result is explicit');
    assert(!JSON.stringify(report).includes(blockedRoot), 'artifact write failure report avoids absolute failed path');
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
}

{
  const artifactRoot = mkdtempSync(join(tmpdir(), 'recursion-harness-'));
  try {
    const report = await runSillyTavernLiveSmoke({
      argv: ['--live', '--write-artifacts'],
      env: {
        RECURSION_SILLYTAVERN_USER: 'default-user',
        SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000'
      },
      artifactRoot
    });
    assertEqual(report.status, 'unsafe-user', 'unsafe artifact run fails closed');
    const runRoot = join(artifactRoot, 'live-smoke', 'sillytavern', report.runId);
    const summary = readFileSync(join(runRoot, 'summary.md'), 'utf8');
    assert(summary.indexOf('## Failures') < summary.indexOf('## Checks'), 'summary lists failures before checks');
    assert(summary.indexOf('## Failures') < summary.indexOf('## Next Action'), 'summary lists failures before next action');
    assert(summary.includes('unsafe-user: dedicated-user-policy'), 'summary includes unsafe-user failure line');
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
}

console.log('[pass] live harness');
