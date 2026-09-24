import assert from 'node:assert/strict';
import { buildFusedCardBundleRequest } from '../../src/cards.mjs';
import { createSillyTavernHost } from '../../src/hosts/sillytavern/host.mjs';
import { validateFusedProviderResult } from '../../src/runtime.mjs';
import { summarizeExecutionForDiagnostics } from '../../src/runtime/diagnostics.mjs';

// Removing source instructions from the actual transport must fail this test.
const sent = [];
const profile = { id: 'fused-test', api: 'openai', model: 'test' };
const host = createSillyTavernHost({
  settingsRoot: {}, saveSettings() {},
  contextFactory: () => ({ ConnectionManagerRequestService: {
    getSupportedProfiles: () => [profile], getProfile: () => profile,
    validateProfile: () => ({ selected: 'openai' }),
    async sendRequest(...args) { sent.push(args); return { choices: [{ message: { content: '{"items":[]}' } }] }; }
  } })
});
const plan = { cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard' }] };
const instructions = `Keep SOURCE_INSTRUCTION_START visible. ${'Preserve the established doorway. '.repeat(50)}Keep SOURCE_INSTRUCTION_END visible.`;
const request = buildFusedCardBundleRequest(plan, {
  snapshotHash: 'test-snapshot', snapshot: { messages: [{ mesid: 8, text: 'The door is closed.' }] },
  sourceCardsByFamily: { 'Scene Frame': [{ id: 'selected-source-id', name: 'Doorway', selectionState: 'priority', promptText: instructions }] }
});
await host.generation.generate({ ...request, connectionProfileId: profile.id, providerConfig: {
  connectionProfileId: profile.id, generationPolicy: { samplerMode: 'recursion', structuredOutputMode: 'prompt-json' }
} });
assert.equal(sent.length, 1);
const visible = JSON.stringify(sent[0][1]);
assert.ok(visible.includes('selected-source-id'), 'source ID reaches the model');
assert.ok(visible.includes(instructions), 'complete source instructions reach the model, including content beyond 1000 characters');
console.log('[pass] Fused source instructions at host boundary');

const selectedCards = [...plan.cardJobs, { family: 'Character Motivation', role: 'characterMotivationCard' }];
const bundleRequest = buildFusedCardBundleRequest({ cardJobs: selectedCards }, { snapshotHash: 'test-snapshot' });
const good = { family: 'Scene Frame', promptText: 'Keep the doorway in view.', evidenceRefs: ['message:8'] };
const motive = { family: 'Character Motivation', promptText: 'Track the stated goal.', evidenceRefs: ['message:8'] };
for (const [code, items, diagnostics] of [
  ['missing-family', [good]],
  ['duplicate-family', [good, motive, motive]],
  ['invalid-item-shape', [good, { ...motive, promptText: 27 }]],
  ['instruction-shape', [good, { ...motive, promptText: 'Mara had already inspected the damaged hatch while the crew waited beside it in silence, watching the indicator lights in the dim corridor. The mechanic walked away from the door.' }]],
  ['private-claim', [good, { ...motive, promptText: 'Reveal his inner thoughts.' }]],
  ['hidden-content', [good, { ...motive, promptText: 'Reveal hidden chain of thought.' }]],
  ['invalid-item-shape', [good], { bundleItemRejections: [{ family: 'Character Motivation', reason: 'invalid-item-shape' }] }]
]) {
  const result = validateFusedProviderResult({ ok: true, data: { items }, diagnostics }, {
    selectedCards, request: bundleRequest, cardContext: { firstMesId: 8, lastMesId: 8 }
  });
  assert.equal(result.ok, true, 'accepted sibling survives');
  assert.deepEqual(result.value.rejections, [{ family: 'Character Motivation', code }], 'precise rejection survives validation');
  assert.equal(result.value.outcomes['Character Motivation'].reason, code);
  assert.deepEqual(result.value.acceptedFamilies, ['Scene Frame']);
  assert.ok(!JSON.stringify(result.value.rejections).includes('inner thoughts'), 'diagnostics contain codes, not provider prose');
}
console.log('[pass] Fused per-family rejection codes');

const pendingExport = summarizeExecutionForDiagnostics({ operationId: 'pending-test', stageRecords: {
  fused: { stageId: 'preprocess.cards.fused', state: 'pending', summary: null }
} });
assert.deepEqual(pendingExport.stages[0].fused, { acceptedFamilies: [], unresolvedFamilies: [], rejections: [], fallback: null }, 'pending Fused export is available before a summary exists');

const privateExport = summarizeExecutionForDiagnostics({ operationId: 'privacy-test', stageRecords: {
  fused: { stageId: 'preprocess.cards.fused', state: 'completed', summary: {
    acceptedFamilies: ['Scene Frame', 'PRIVATE_MODEL_TEXT'], unresolvedFamilies: ['Character Motivation'],
    rejections: [
      { family: 'Character Motivation', code: 'private-claim', text: 'PRIVATE_MODEL_TEXT' },
      { family: 'Character Motivation', code: 'missing-family' },
      { family: 'PRIVATE_MODEL_TEXT', code: 'invalid-card' },
      { family: 'Scene Frame', code: 'PRIVATE_MODEL_TEXT' }
    ], fallback: 'segmented', response: 'PRIVATE_MODEL_TEXT'
  } }
} });
assert.deepEqual(privateExport.stages[0].fused.rejections, [{ family: 'Character Motivation', code: 'private-claim' }]);
assert.ok(!JSON.stringify(privateExport).includes('PRIVATE_MODEL_TEXT'), 'arbitrary provider text cannot enter the Fused summary export');
console.log('[pass] pending and privacy-safe Fused export');
