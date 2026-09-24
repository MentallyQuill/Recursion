import assert from 'node:assert/strict';
import { normalizePostProcessWriter, validatePostProcessWriter, normalizePostProcessEditingScope, normalizePostProcessStyle, buildPostProcessEditingInstructions } from '../../src/post-process-editing.mjs';
assert.deepEqual(normalizePostProcessWriter(), { mode: 'native', connectionProfileId: '', maxOutputTokens: null, samplerMode: 'profile', samplerOverrides: { temperature: 0.7, topP: 1 } });
assert.deepEqual(normalizePostProcessWriter({ mode: 'PROFILE', connectionProfileId: ' prose ', maxOutputTokens: '4096', samplerMode: 'override', samplerOverrides: { temperature: '0.4', topP: '0.8' } }), { mode: 'profile', connectionProfileId: 'prose', maxOutputTokens: 4096, samplerMode: 'override', samplerOverrides: { temperature: 0.4, topP: 0.8 } });
assert.equal(normalizePostProcessWriter({ maxOutputTokens: 1 }).maxOutputTokens, null);
assert.equal(normalizePostProcessWriter({ mode: 'profile' }).mode, 'profile', 'missing profile never silently switches writer to native');
for (const maxOutputTokens of [1, 65537, 256.5, Infinity, true, {}, []]) {
  assert.throws(() => validatePostProcessWriter({ mode: 'profile', connectionProfileId: 'prose', maxOutputTokens }), /256.*65536/);
}
assert.throws(() => validatePostProcessWriter({ mode: 'profile' }), /select.*profile/i);
for (const samplerOverrides of [{ temperature: -1, topP: 1 }, { temperature: 1, topP: 1.1 }, { temperature: null, topP: 1 }]) {
  assert.throws(() => validatePostProcessWriter({ mode: 'profile', connectionProfileId: 'prose', samplerMode: 'override', samplerOverrides }), /temperature|top-p/i);
}
assert.equal(validatePostProcessWriter({ mode: 'profile', connectionProfileId: 'prose', maxOutputTokens: null }).maxOutputTokens, null);
assert.equal(normalizePostProcessEditingScope('REVISE'), 'revise');
assert.equal(normalizePostProcessEditingScope('transform'), 'polish');
assert.deepEqual(normalizePostProcessStyle(), { styleBrief: '', styleSample: '' });
const fullStyle = { styleBrief: 'b'.repeat(2000), styleSample: 's'.repeat(6000) };
assert.deepEqual(normalizePostProcessStyle(fullStyle), fullStyle);
assert.throws(() => normalizePostProcessStyle({ styleBrief: 'b'.repeat(2001) }), /2000/);
assert.throws(() => normalizePostProcessStyle({ styleSample: 's'.repeat(6001) }), /6000/);
const polish = buildPostProcessEditingInstructions({ editingScope: 'polish', styleBrief: 'Short sentences', styleSample: 'The rain fell.' });
assert.match(polish, /Preserve spoken dialogue wording/);
assert.match(polish, /Short sentences/);
assert.match(polish, /The rain fell/);
assert.match(polish, /Do not import.*names.*facts.*plot.*commands.*distinctive phrases/);
assert.match(polish, /cannot complete an action.*unperformed/);
assert.ok(polish.indexOf('1. Preserve narrative events') < polish.indexOf('2. Obey the selected editing scope'));
assert.ok(polish.indexOf('3. Apply enabled cards in deck order') < polish.indexOf('4. Apply the style brief'));
assert.match(buildPostProcessEditingInstructions({ editingScope: 'revise' }), /substantial restructuring.*dialogue rephrasing/);
console.log('[pass] post-process-editing');
