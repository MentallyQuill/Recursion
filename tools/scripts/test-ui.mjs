import { activityLabel, createRecursionViewModel, mountRecursionUi } from '../../src/ui.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

assertEqual(activityLabel({ phase: 'cardBatchRunning' }), 'Generating scene cards...', 'phase label mapped');
const model = createRecursionViewModel({
  settings: { mode: 'auto' },
  lastHand: { cards: [{ id: 'c1' }, { id: 'c2' }] },
  activity: { phase: 'settled', label: 'Recursion prompt ready.', severity: 'success' },
  lastPacket: { diagnostics: { composerLane: 'utility' } }
});
assertEqual(model.statusText, 'Ready - Auto', 'status text built');
assertEqual(model.handCount, 2, 'hand count built');
assertEqual(model.composerLabel, 'Utility', 'composer label built');

assertEqual(activityLabel({ phase: 'promptInstalling' }), 'Installing Recursion prompt...', 'prompt phase label mapped');
assertEqual(activityLabel({ phase: 'idle' }), '', 'idle phase has no working label');
assertEqual(activityLabel({ label: 'Custom visible label.', phase: 'unknown' }), 'Custom visible label.', 'activity label overrides phase');
assertEqual(activityLabel({ phase: 'unknown' }), 'Recursion is working...', 'unknown phase label falls back');

const fallbackModel = createRecursionViewModel({});
assertEqual(fallbackModel.statusText, 'Ready - Observe', 'missing view defaults to observe ready status');
assertEqual(fallbackModel.handCount, 0, 'missing hand defaults to zero');
assertEqual(fallbackModel.composerLabel, 'Utility', 'missing composer defaults to Utility');
assertEqual(fallbackModel.reasonerState, 'Unavailable', 'missing reasoner provider is unavailable');

const activeModel = createRecursionViewModel({
  settings: { mode: 'off', providers: { reasoner: { enabled: false, lastTest: { status: 'failed' } } } },
  lastHand: { cards: 'not-cards' },
  activity: {
    phase: 'reasonerComposing',
    severity: 'warning',
    chips: [' Reasoner ', '', null, 'Cards', 'Cards', 3],
    providerLane: 'reasoner'
  },
  lastPacket: { diagnostics: { composerLane: 'reasoner' } }
});
assertEqual(activeModel.statusText, 'Working - Off', 'non-settled status is working');
assertEqual(activeModel.activitySeverity, 'warning', 'activity severity is preserved');
assertDeepEqual(activeModel.activityChips, ['Reasoner', 'Cards', '3'], 'activity chips are normalized and deduped');
assertEqual(activeModel.composerLabel, 'Reasoner', 'reasoner composer label built');
assertEqual(activeModel.reasonerState, 'Disabled', 'disabled reasoner state built');

const reasonerAvailable = createRecursionViewModel({
  settings: { mode: 'auto', providers: { reasoner: { enabled: true, lastTest: { status: 'ok' } } } },
  activity: { phase: 'idle' }
});
assertEqual(reasonerAvailable.reasonerState, 'Available', 'available reasoner state built');

const reasonerPassAvailable = createRecursionViewModel({
  settings: { mode: 'auto', providers: { reasoner: { enabled: true, lastTest: { status: 'pass' } } } },
  activity: { phase: 'idle' }
});
assertEqual(reasonerPassAvailable.reasonerState, 'Available', 'pass reasoner test status is available');

const reasonerFailIssue = createRecursionViewModel({
  settings: { mode: 'auto', providers: { reasoner: { enabled: true, lastTest: { status: 'fail' } } } },
  activity: { phase: 'idle' }
});
assertEqual(reasonerFailIssue.reasonerState, 'Issue', 'fail reasoner test status is an issue');

const sensitiveView = {
  settings: {
    mode: 'auto',
    providers: {
      utility: {
        lastTest: { compactError: 'Bearer ui-token and sk-ui-secret' },
        privateKey: 'plain-private-key',
        sessionKey: 'plain-session-key',
        authHeader: 'plain-auth-header',
        credentials: 'plain-credentials',
        sessionApiKey: 'plain-session-api-key'
      }
    }
  },
  lastHand: {
    cards: [{ id: 'card-secret', family: 'Scene Frame', promptText: 'Prompt card with private-secret' }]
  },
  activity: {
    phase: 'promptInstalling',
    detail: { message: 'Bearer activity-token' }
  },
  lastPacket: {
    sections: { turnBrief: 'Raw prompt text with sk-ui-packet and private-secret' },
    diagnostics: { composerLane: 'utility', promptPacketHash: 'packet-hash' }
  },
  circular: null,
  big: 2n
};
sensitiveView.circular = sensitiveView;

const noDocumentMount = mountRecursionUi({ runtime: { view: () => ({}) } });
assertEqual(typeof noDocumentMount.update, 'function', 'no-document mount returns update function');
assertEqual(typeof noDocumentMount.destroy, 'function', 'no-document mount returns destroy function');
noDocumentMount.update();
noDocumentMount.destroy();

function createFakeDocument() {
  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.eventListeners = {};
      this.hidden = false;
      this.parentNode = null;
      this.id = '';
      this.className = '';
      this.textContent = '';
      this.type = '';
      this.role = '';
      this.ariaLabel = '';
      this.open = false;
      this.value = '';
      this.checked = false;
      this.disabled = false;
    }

    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    }

    insertBefore(child, before = null) {
      child.parentNode = this;
      const index = before ? this.children.indexOf(before) : -1;
      if (index >= 0) this.children.splice(index, 0, child);
      else this.children.push(child);
      return child;
    }

    remove() {
      if (!this.parentNode) return;
      const index = this.parentNode.children.indexOf(this);
      if (index >= 0) this.parentNode.children.splice(index, 1);
      this.parentNode = null;
    }

    replaceChildren(...children) {
      this.children = [];
      for (const child of children) this.appendChild(child);
    }

    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === 'id') this.id = String(value);
      if (name === 'class') this.className = String(value);
      if (name === 'role') this.role = String(value);
      if (name === 'aria-label') this.ariaLabel = String(value);
      if (name === 'value') this.value = String(value);
      if (name === 'type') this.type = String(value);
      if (name === 'disabled') this.disabled = true;
      if (name === 'checked') this.checked = true;
      if (name.startsWith('data-')) {
        const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        this.dataset[key] = String(value);
      }
    }

    getAttribute(name) {
      return this.attributes[name] ?? null;
    }

    addEventListener(type, listener) {
      if (!this.eventListeners[type]) this.eventListeners[type] = [];
      this.eventListeners[type].push(listener);
    }

    click() {
      const event = { target: this };
      let node = this;
      while (node) {
        for (const listener of node.eventListeners.click || []) listener(event);
        node = node.parentNode;
      }
    }

    showModal() {
      this.open = true;
    }

    close() {
      this.open = false;
    }

    querySelector(selector) {
      return findFirst(this, selector);
    }
  }

  function matches(element, selector) {
    if (selector.startsWith('#')) return element.id === selector.slice(1);
    const dataMatch = selector.match(/^\[data-([a-z0-9-]+)\]$/i);
    if (dataMatch) {
      const key = dataMatch[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      return Object.prototype.hasOwnProperty.call(element.dataset, key);
    }
    return element.tagName.toLowerCase() === selector.toLowerCase();
  }

  function findFirst(element, selector) {
    for (const child of element.children) {
      if (matches(child, selector)) return child;
      const nested = findFirst(child, selector);
      if (nested) return nested;
    }
    return null;
  }

  function textTree(element) {
    return [
      element.textContent,
      ...element.children.map((child) => textTree(child))
    ].join(' ');
  }

  const body = new FakeElement('body');
  return {
    body,
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: (id) => findFirst(body, `#${id}`),
    textTree
  };
}

const previousDocument = globalThis.document;
const previousWindow = globalThis.window;
const previousNavigator = globalThis.navigator;
const previousSetTimeout = globalThis.setTimeout;
const previousClearTimeout = globalThis.clearTimeout;
const previousSetInterval = globalThis.setInterval;
const previousClearInterval = globalThis.clearInterval;
try {
  let timerId = 0;
  const timers = [];
  const fakeSetTimeout = (callback, delay) => {
    const timer = { id: ++timerId, kind: 'timeout', callback, delay, active: true };
    timers.push(timer);
    return timer;
  };
  const fakeClearTimeout = (timer) => {
    if (timer) timer.active = false;
  };
  const fakeSetInterval = (callback, delay) => {
    const timer = { id: ++timerId, kind: 'interval', callback, delay, active: true };
    timers.push(timer);
    return timer;
  };
  const fakeClearInterval = (timer) => {
    if (timer) timer.active = false;
  };
  const runNextTimeout = (delay) => {
    const timer = timers.find((entry) => entry.kind === 'timeout' && entry.delay === delay && entry.active);
    assert(timer, `expected active timeout for ${delay}ms`);
    timer.active = false;
    timer.callback();
  };

  const fakeDocument = createFakeDocument();
  globalThis.document = fakeDocument;
  globalThis.setTimeout = fakeSetTimeout;
  globalThis.clearTimeout = fakeClearTimeout;
  globalThis.setInterval = fakeSetInterval;
  globalThis.clearInterval = fakeClearInterval;
  globalThis.window = {
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval
  };
  const copied = [];
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        writeText: async (text) => {
          copied.push(String(text));
        }
      }
    }
  });
  let refreshed = 0;
  let closeCount = 0;
  const settingsUpdates = [];
  const providerUpdates = [];
  const providerTests = [];
  const providerClears = [];
  let resolveOffSettingsUpdate = null;
  let offSettingsUpdate = null;
  let view = {
    settings: {
      mode: 'auto',
      strength: 'balanced',
      promptFootprint: 'normal',
      focus: 'balanced',
      reasonerUse: 'auto',
      providers: {
        utility: {
          lane: 'utility',
          enabled: true,
          source: 'host-current-model',
          hostConnectionProfileId: '',
          openAICompatible: { baseUrl: '', model: '', sessionApiKeyPresent: false },
          temperature: 0.1,
          topP: 0.95,
          maxTokens: 4096,
          lastTest: { status: 'not-run' }
        },
        reasoner: {
          lane: 'reasoner',
          enabled: true,
          source: 'host-current-model',
          hostConnectionProfileId: '',
          openAICompatible: { baseUrl: '', model: '', sessionApiKeyPresent: false },
          temperature: 0.4,
          topP: 0.95,
          maxTokens: 4096,
          lastTest: { status: 'not-run' }
        }
      }
    },
    lastHand: { handId: 'hand-ui', cards: [{ id: 'card-a', family: 'Scene Frame', summary: 'Door stays blocked.', emphasis: 'critical' }] },
    activity: { phase: 'cardBatchRunning', severity: 'info', chips: ['Utility', 'Cards'] },
    lastPacket: {
      packetId: 'packet-ui',
      chatId: 'chat-ui',
      sceneKey: 'scene-ui',
      selectedCardRefs: [{ cardId: 'card-a', family: 'Scene Frame' }],
      diagnostics: { composerLane: 'utility' }
    }
  };
  const ui = mountRecursionUi({
    runtime: {
      view: () => view,
      refreshScene: () => {
        refreshed += 1;
      },
      updateSettings: (patch) => {
        settingsUpdates.push(patch);
        view = { ...view, settings: { ...view.settings, ...patch } };
        if (patch?.mode === 'off') {
          view = {
            ...view,
            activity: {
              phase: 'promptClearing',
              severity: 'info',
              label: 'Clearing Recursion prompt...',
              chips: ['Prompt']
            }
          };
          offSettingsUpdate = new Promise((resolve) => {
            resolveOffSettingsUpdate = () => {
              view = {
                ...view,
                activity: {
                  phase: 'settled',
                  severity: 'warning',
                  label: 'Prompt clear failed. Recursion skipped without clearing host prompt.',
                  chips: ['Prompt']
                }
              };
              resolve({ ok: false, settings: view.settings, clear: { ok: false } });
            };
          });
          return offSettingsUpdate;
        }
        return view.settings;
      },
      updateProvider: (lane, patch) => {
        providerUpdates.push({ lane, patch });
        view = {
          ...view,
          settings: {
            ...view.settings,
            providers: {
              ...view.settings.providers,
              [lane]: {
                ...view.settings.providers[lane],
                ...patch,
                openAICompatible: {
                  ...view.settings.providers[lane].openAICompatible,
                  ...(patch.openAICompatible || {}),
                  sessionApiKeyPresent: Boolean(patch.apiKey) || view.settings.providers[lane].openAICompatible.sessionApiKeyPresent
                }
              }
            }
          }
        };
        return view.settings.providers[lane];
      },
      testProvider: async (lane) => {
        providerTests.push(lane);
        return { ok: true };
      },
      clearProviderKey: (lane) => {
        providerClears.push(lane);
        view = {
          ...view,
          settings: {
            ...view.settings,
            providers: {
              ...view.settings.providers,
              [lane]: {
                ...view.settings.providers[lane],
                openAICompatible: {
                  ...view.settings.providers[lane].openAICompatible,
                  sessionApiKeyPresent: false
                }
              }
            }
          }
        };
        return view.settings.providers[lane];
      }
    },
    mountPoint: fakeDocument.body
  });

  const root = fakeDocument.getElementById('recursion-root');
  assert(root, 'root is rendered');
  assert(root.querySelector('[data-recursion-bar]'), 'bar selector is rendered');
  assert(root.querySelector('[data-recursion-activity-ribbon]'), 'activity ribbon selector is rendered');
  assert(root.querySelector('[data-recursion-action-menu]'), 'actions menu selector is rendered');
  assert(root.querySelector('[data-recursion-hand-dropdown]'), 'hand dropdown selector is rendered');
  assert(root.querySelector('[data-recursion-settings-panel]'), 'settings panel selector is rendered');
  assert(root.querySelector('[data-recursion-viewer]'), 'viewer selector is rendered');
  const promptPacketNode = root.querySelector('[data-recursion-prompt-packet]');
  assert(promptPacketNode, 'prompt packet metadata selector is rendered');
  const promptPacketMetadata = JSON.parse(promptPacketNode.textContent);
  assertEqual(promptPacketMetadata.packetId, 'packet-ui', 'prompt packet metadata includes packet id');
  assertEqual(promptPacketMetadata.handId, 'hand-ui', 'prompt packet metadata includes hand id from the last hand');
  assertDeepEqual(promptPacketMetadata.selectedCardRefs.map((entry) => entry.cardId), ['card-a'], 'prompt packet metadata includes selected card refs');
  assertEqual(root.querySelector('[data-recursion-activity-ribbon]').hidden, true, 'foreground ribbon waits briefly before revealing working activity');
  assertEqual(root.querySelector('[data-recursion-status]').textContent, 'Working - Auto', 'rendered status text');
  assertEqual(root.querySelector('[data-recursion-hand-count]').textContent, 'Hand 1', 'rendered hand count');
  assertEqual(root.querySelector('[data-recursion-composer]').textContent, 'Utility', 'rendered composer');

  root.querySelector('[data-recursion-actions]').click();
  assertEqual(root.querySelector('[data-recursion-action-menu]').hidden, false, 'actions button opens action menu');
  root.querySelector('[data-recursion-action-refresh]').click();
  assertEqual(refreshed, 1, 'actions button calls refresh scene');
  root.querySelector('[data-recursion-action-mode-toggle]').click();
  assertDeepEqual(settingsUpdates.at(-1), { mode: 'observe' }, 'mode toggle updates high-level settings');
  root.querySelector('[data-recursion-settings-toggle]').click();
  assertEqual(root.querySelector('[data-recursion-settings-panel]').hidden, false, 'settings action opens settings panel');

  root.querySelector('[data-recursion-setting-mode]').value = 'auto';
  root.querySelector('[data-recursion-setting-strength]').value = 'strong';
  root.querySelector('[data-recursion-setting-footprint]').value = 'rich';
  root.querySelector('[data-recursion-setting-focus]').value = 'character';
  root.querySelector('[data-recursion-setting-reasoner]').value = 'always';
  root.querySelector('[data-recursion-settings-save]').click();
  assertDeepEqual(settingsUpdates.at(-1), {
    mode: 'auto',
    strength: 'strong',
    promptFootprint: 'rich',
    focus: 'character',
    reasonerUse: 'always'
  }, 'settings panel saves broad behavior controls');
  root.querySelector('[data-recursion-setting-mode]').value = 'off';
  root.querySelector('[data-recursion-settings-save]').click();
  assertDeepEqual(settingsUpdates.at(-1), {
    mode: 'off',
    strength: 'strong',
    promptFootprint: 'rich',
    focus: 'character',
    reasonerUse: 'always'
  }, 'settings panel can switch Recursion Off');
  assertEqual(root.querySelector('[data-recursion-status]').textContent, 'Working - Off', 'Off settings save shows cleanup work');
  assertEqual(root.querySelector('[data-recursion-ribbon-label]').textContent, 'Clearing Recursion prompt...', 'Off settings save shows prompt cleanup label');
  resolveOffSettingsUpdate();
  await offSettingsUpdate;
  ui.update();
  assertEqual(root.querySelector('[data-recursion-status]').textContent, 'Ready - Off', 'Off warning still leaves mode ready');
  assertEqual(root.querySelector('[data-recursion-ribbon-label]').textContent, 'Prompt clear failed. Recursion skipped without clearing host prompt.', 'Off clear warning label remains visible');
  assertEqual(root.querySelector('[data-recursion-activity-ribbon]').hidden, false, 'Off clear warning ribbon stays visible');

  root.querySelector('[data-recursion-provider-source-utility]').value = 'openai-compatible';
  root.querySelector('[data-recursion-provider-profile-utility]').value = 'utility-profile';
  root.querySelector('[data-recursion-provider-base-url-utility]').value = 'https://utility.example/v1';
  root.querySelector('[data-recursion-provider-model-utility]').value = 'utility-model';
  root.querySelector('[data-recursion-provider-api-key-utility]').value = 'sk-ui-secret';
  root.querySelector('[data-recursion-provider-temperature-utility]').value = '0.2';
  root.querySelector('[data-recursion-provider-top-p-utility]').value = '0.8';
  root.querySelector('[data-recursion-provider-max-tokens-utility]').value = '2048';
  root.querySelector('[data-recursion-utility-provider-save]').click();
  assertEqual(providerUpdates.at(-1).lane, 'utility', 'utility provider save targets utility lane');
  assertEqual(providerUpdates.at(-1).patch.source, 'openai-compatible', 'provider save records source');
  assertEqual(providerUpdates.at(-1).patch.openAICompatible.model, 'utility-model', 'provider save records model');
  assertEqual(providerUpdates.at(-1).patch.apiKey, 'sk-ui-secret', 'provider save forwards session key without writing it into text');
  assert(!fakeDocument.textTree(root).includes('sk-ui-secret'), 'provider controls do not render session api key text');

  root.querySelector('[data-recursion-utility-provider-test]').click();
  await Promise.resolve();
  assertDeepEqual(providerTests, ['utility'], 'utility provider test action calls runtime');
  root.querySelector('[data-recursion-utility-provider-clear-key]').click();
  assertDeepEqual(providerClears, ['utility'], 'utility clear session key action calls runtime');
  root.querySelector('[data-recursion-actions]').click();
  root.querySelector('[data-recursion-copy-prompt-packet]').click();
  await Promise.resolve();
  assert(copied[0].includes('composerLane'), 'copy prompt packet writes sanitized packet preview');

  const viewer = root.querySelector('[data-recursion-viewer]');
  let showModalCount = 0;
  viewer.showModal = () => {
    showModalCount += 1;
    if (viewer.open) throw new Error('showModal called while viewer already open');
    viewer.open = true;
  };
  root.querySelector('[data-recursion-viewer-toggle]').click();
  assertEqual(showModalCount, 1, 'viewer toggle opens dialog once per click');
  viewer.close = () => {
    closeCount += 1;
    viewer.open = false;
  };

  view = {
    ...view,
    settings: { ...view.settings, mode: 'auto' },
    activity: { phase: 'settled', severity: 'success', label: 'Recursion prompt ready.' }
  };
  ui.update();
  ui.update();
  assertEqual(root.querySelector('[data-recursion-status]').textContent, 'Ready - Auto', 'update refreshes status text');
  runNextTimeout(2000);
  assertEqual(root.querySelector('[data-recursion-activity-ribbon]').hidden, true, 'success ribbon collapses after the success timeout');
  ui.update();
  assertEqual(root.querySelector('[data-recursion-activity-ribbon]').hidden, true, 'success ribbon stays collapsed while the same success activity is polled');
  view = { ...view, activity: { phase: 'providerIssue', severity: 'warning', label: 'Provider test failed.' } };
  ui.update();
  assertEqual(root.querySelector('[data-recursion-activity-ribbon]').hidden, false, 'warning ribbon appears immediately and persists');
  root.querySelector('[data-recursion-viewer-close]').click();
  assertEqual(closeCount, 1, 'viewer close listener is not duplicated across updates');

  view = { settings: { mode: 'auto' }, activity: { phase: 'idle' }, lastHand: { cards: [] } };
  ui.update();
  const idleViewerText = fakeDocument.textTree(viewer);
  assert(!idleViewerText.includes('Recursion is working...'), 'idle viewer does not report active work');

  view = sensitiveView;
  ui.update();
  const viewerText = fakeDocument.textTree(viewer);
  assert(!viewerText.includes('Raw prompt text'), 'viewer omits raw prompt sections');
  assert(!viewerText.includes('sk-ui-packet'), 'viewer redacts packet secrets');
  assert(!viewerText.includes('private-secret'), 'viewer redacts private secret text');
  assert(!viewerText.includes('Bearer ui-token'), 'viewer redacts settings secrets');
  assert(!viewerText.includes('plain-private-key'), 'viewer redacts privateKey values');
  assert(!viewerText.includes('plain-session-key'), 'viewer redacts sessionKey values');
  assert(!viewerText.includes('plain-auth-header'), 'viewer redacts authHeader values');
  assert(!viewerText.includes('plain-credentials'), 'viewer redacts credentials values');
  assert(!viewerText.includes('plain-session-api-key'), 'viewer redacts sessionApiKey values');
  assert(viewerText.includes('packet-hash'), 'viewer keeps safe prompt packet diagnostics');

  ui.destroy();
  assertEqual(fakeDocument.getElementById('recursion-root'), null, 'destroy removes root');
} finally {
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
  if (previousNavigator === undefined) delete globalThis.navigator;
  else Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator });
  globalThis.setTimeout = previousSetTimeout;
  globalThis.clearTimeout = previousClearTimeout;
  globalThis.setInterval = previousSetInterval;
  globalThis.clearInterval = previousClearInterval;
}

console.log('[pass] ui');
