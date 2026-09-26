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
// Ordinary chat replies must not mark unchanged prose between distant edits.
const middle = 'The lamp stayed on while they waited beside the closed door. '.repeat(35);
for (const separator of [' ', '\n\n']) {
  const original = `Before.${separator}${middle}${separator}Finish.`;
  const revised = `After.${separator}${middle}${separator}End.`;
  const diff = buildRevisionDiff(original, revised);
  assert.equal(diff.coarse, false, 'ordinary replies retain word-level comparison');
  assert.equal(diff.original.filter(part => part.changed).map(part => part.text).join(''), 'Before.Finish.');
  assert.equal(diff.revised.filter(part => part.changed).map(part => part.text).join(''), 'After.End.');
  assert.equal(diff.original.map(part => part.text).join(''), original);
  assert.equal(diff.revised.map(part => part.text).join(''), revised);
}
const longMiddle = 'An unchanged paragraph remains readable.\n'.repeat(1500);
const longDiff = buildRevisionDiff(`Before.\n${longMiddle}Finish.`, `After.\n${longMiddle}End.`);
assert.equal(longDiff.coarse, true);
assert.equal(longDiff.original.filter(part => !part.changed).map(part => part.text).join(''), longMiddle,
  'block fallback preserves matching paragraphs between edits');
for (const [original, revised, removed, added] of [
  ['', 'New text', '', 'New text'], ['Old text', '', 'Old text', ''],
  ['A B C', 'A new B C', '', 'new '], ['A old B C', 'A B C', 'old ', ''],
  ['雨 fell softly. 🕯️', '雨 fell quietly. 🕯️', 'softly.', 'quietly.'],
  ['Line one.\r\n\r\nLine two.', 'Line one.\n\nLine two.', '\r\n\r\n', '\n\n']
]) {
  const diff = buildRevisionDiff(original, revised);
  assert.equal(diff.original.map(part => part.text).join(''), original);
  assert.equal(diff.revised.map(part => part.text).join(''), revised);
  assert.equal(diff.original.filter(part => part.changed).map(part => part.text).join(''), removed);
  assert.equal(diff.revised.filter(part => part.changed).map(part => part.text).join(''), added);
}
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

for (const [status, expected] of [['writing','Writing revision'],['awaiting-review','Ready for review'],['applied','Revision applied'],['no-change','No changes needed'],['canceled','Canceled'],['failed','time limit']]) {
  controls.length=0;
  renderPostProcessWritingControls({el:element,deck:{readonly:true},settings:{},status:{status,failure:{message:'Post-process exceeded its time limit. Original response preserved.'}}});
  const outcome=controls.find(control=>control.dataset?.recursionPostProcessStatus===status);
  assert.ok(outcome,`renders retained ${status} outcome`);
  assert.match(outcome.text,new RegExp(expected,'i'));
  assert.equal(outcome.attrs.role,'status');
}
console.log('Post-process retained outcome UI: PASS');
