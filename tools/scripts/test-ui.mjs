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
try {
  const fakeDocument = createFakeDocument();
  globalThis.document = fakeDocument;
  globalThis.window = { setInterval, clearInterval };
  let refreshed = 0;
  let closeCount = 0;
  let view = {
    settings: { mode: 'auto', providers: { reasoner: { enabled: true } } },
    lastHand: { cards: [{ id: 'card-a', family: 'Scene Frame', summary: 'Door stays blocked.', emphasis: 'critical' }] },
    activity: { phase: 'cardBatchRunning', severity: 'info', chips: ['Utility', 'Cards'] },
    lastPacket: { diagnostics: { composerLane: 'utility' } }
  };
  const ui = mountRecursionUi({
    runtime: {
      view: () => view,
      refreshScene: () => {
        refreshed += 1;
      }
    },
    mountPoint: fakeDocument.body
  });

  const root = fakeDocument.getElementById('recursion-root');
  assert(root, 'root is rendered');
  assert(root.querySelector('[data-recursion-bar]'), 'bar selector is rendered');
  assert(root.querySelector('[data-recursion-activity-ribbon]'), 'activity ribbon selector is rendered');
  assert(root.querySelector('[data-recursion-hand-dropdown]'), 'hand dropdown selector is rendered');
  assert(root.querySelector('[data-recursion-viewer]'), 'viewer selector is rendered');
  assertEqual(root.querySelector('[data-recursion-status]').textContent, 'Working - Auto', 'rendered status text');
  assertEqual(root.querySelector('[data-recursion-hand-count]').textContent, 'Hand 1', 'rendered hand count');
  assertEqual(root.querySelector('[data-recursion-composer]').textContent, 'Utility', 'rendered composer');

  root.querySelector('[data-recursion-actions]').click();
  assertEqual(refreshed, 1, 'actions button calls refresh scene');

  const viewer = root.querySelector('[data-recursion-viewer]');
  viewer.close = () => {
    closeCount += 1;
    viewer.open = false;
  };

  view = { ...view, activity: { phase: 'settled', severity: 'success', label: 'Recursion prompt ready.' } };
  ui.update();
  ui.update();
  assertEqual(root.querySelector('[data-recursion-status]').textContent, 'Ready - Auto', 'update refreshes status text');
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
}

console.log('[pass] ui');
