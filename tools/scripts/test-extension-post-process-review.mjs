import assert from 'node:assert/strict';
import { installPostProcessMessageActions } from '../../src/extension/index.js';
const actions = [];
function element() {
  return { dataset: {}, attributes: {}, handlers: {}, children: [],
    setAttribute(key, value) { this.attributes[key] = String(value); },
    getAttribute(key) { return this.attributes[key] ?? null; },
    addEventListener(key, handler) { this.handlers[key] = handler; },
    appendChild(child) { child.parent = this; this.children.push(child); },
    remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
  };
}
const rail = element();
const message = { getAttribute: () => '7', querySelector: selector => selector === '.mes_buttons' ? rail : rail.children[0] || null };
const document = { querySelectorAll: selector => selector === '.mes[mesid]' ? [message] : rail.children, querySelector: () => null, createElement: element };
let update;
const records = [
  { id: 'other-swipe', state: 'applied', targetIdentity: { messageId: 7, swipeId: 0, sourceTextHash: 'wrong' } },
  { id: 'exact-swipe', state: 'pending', targetIdentity: { messageId: 7, swipeId: 2, sourceTextHash: 'exact' } }
];
const cleanup = installPostProcessMessageActions({ postProcessComparisons: async () => records, subscribe: fn => { update = fn; return () => { update = null; }; } },
  { openPostProcessReview: options => actions.push(options) }, { document, contextProvider: () => ({ chat: Array.from({ length: 8 }, () => ({ swipe_id: 2 })) }) });
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(rail.children.length, 1);
assert.equal(rail.children[0].attributes['aria-label'], 'Review revision');
rail.children[0].handlers.click({ preventDefault() {}, stopPropagation() {} });
assert.deepEqual(actions[0], { targetIdentity: records[1].targetIdentity }, 'message action uses its exact selected swipe identity');
records[1].state = 'applied'; await update();
assert.equal(rail.children[0].attributes['aria-label'], 'Compare revision');
records.length = 0; await update();
assert.equal(rail.children.length, 0, 'expired comparisons remove message actions');
cleanup(); assert.equal(update, null);
console.log('Extension Post-process message actions: PASS');
