import assert from 'node:assert/strict';
import { buildRevisionDiff, renderPostProcessWritingControls } from '../../src/ui/post-process-review.mjs';
const changed = buildRevisionDiff('<img src=x onerror=alert(1)> old', '<img src=x onerror=alert(1)> new');
assert.equal(changed.original.map(part => part.text).join(''), '<img src=x onerror=alert(1)> old');
assert.equal(changed.revised.map(part => part.text).join(''), '<img src=x onerror=alert(1)> new');
assert(changed.original.some(part => part.changed && part.text.includes('old')));
assert(changed.revised.some(part => part.changed && part.text.includes('new')));
const large = buildRevisionDiff('a '.repeat(100000), 'b '.repeat(100000));
assert.equal(large.coarse, true);
assert(large.original.length <= 3 && large.revised.length <= 3);
assert.equal(large.original.map(part => part.text).join(''), 'a '.repeat(100000));
assert.equal(buildRevisionDiff('same', 'same').original.some(part => part.changed), false);
console.log('Post-process comparison UI diff: PASS');

const controls = [];
const element = (tag, options = {}, children = []) => {
  const result = { tag, ...options, children, handlers: {}, addEventListener(type, handler) { this.handlers[type] = handler; }, appendChild(child) { this.children.push(child); } };
  controls.push(result); return result;
};
const patches = [], messages = [];
renderPostProcessWritingControls({ el: element, deck: { readonly: true }, settings: {}, profiles: [], onSettings: patch => patches.push(patch), onError: message => messages.push(message) });
const mode = controls.find(control => control.dataset?.recursionPostProcessWriterMode === '');
mode.value = 'profile'; mode.handlers.change();
assert.equal(patches.length, 0, 'profile mode never persists without a selected profile');
assert.equal(mode.value, 'native');
assert.match(messages[0], /Create a Connection Profile/);
console.log('Post-process empty-profile UI guard: PASS');
