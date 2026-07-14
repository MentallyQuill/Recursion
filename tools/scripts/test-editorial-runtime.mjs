import { createRecursionRuntime } from '../../src/runtime.mjs';
import { createSettingsStore } from '../../src/settings.mjs';
import { createMemoryStorageAdapter, createStorageRepository } from '../../src/storage.mjs';
import { createActivityReporter } from '../../src/activity.mjs';
import { createGenerationRouter } from '../../src/providers.mjs';
import { hashJson } from '../../src/core.mjs';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

const source = 'She smiled. "Who sent you?" He told her the sender name, then reached for the latch.';
const message = { messageId: 8, chatKey: 'editorial-chat', swipeId: 0, text: source, swipes: [source] };
const calls = [];
const host = {
  async snapshot() { return { chatId: 'editorial-chat', chatKey: 'editorial-chat', sceneKey: 'scene', sceneFingerprint: 'scene-fp', turnFingerprint: 'turn-fp', latestMesId: 8, messages: [{ mesid: 8, role: 'assistant', text: source, visible: true }] }; },
  messages: {
    activeAssistantMessageIdentity() { return { ...message, originalHash: hashJson(source) }; },
    async holdAssistantMessage() { calls.push('hold'); message.text = ''; return { ok: true }; },
    async revealAssistantMessage() { calls.push('reveal'); message.text = source; return { ok: true }; },
    async appendAssistantMessageSwipe(_id, text, options) { calls.push({ type: 'append', text, options }); message.text = text; message.swipes.push(text); return { ok: true }; },
    async findEnhancedSwipe() { return null; }
  },
  prompt: { async install() { return { ok: true }; }, async clear() { return { ok: true }; } }
};
const diagnosis = {
  schema: 'recursion.editorialDiagnosis.v1', mode: 'recompose', sourceHash: hashJson(source), snapshotHash: 'any', decision: 'proceed',
  brief: { mode: 'recompose', diagnosis: [{ dimension: 'continuity', problem: 'Unsupported sender detail.', evidenceRefs: ['source:0'] }], preserve: [], discard: [{ claim: 'sender name', evidenceRefs: ['source:0'] }], allowedChanges: ['Rewrite freely'], forbiddenChanges: ['Add unsupported facts'] }
};
const activity = createActivityReporter();
const generationRouter = createGenerationRouter({
  activity,
  client: {
    async generate(roleId, request) {
      calls.push({ roleId, request });
      if (roleId === 'editorialDiagnostician') {
        return {
          text: JSON.stringify({ ...diagnosis, sourceHash: request.sourceHash, snapshotHash: request.snapshotHash }),
          providerId: 'editorial-test-provider',
          model: 'editorial-test-model'
        };
      }
      if (roleId === 'editorialTransformer') {
        const resolvedDiagnosis = { ...diagnosis, sourceHash: request.sourceHash, snapshotHash: request.snapshotHash };
        return {
          text: JSON.stringify({
            schema: 'recursion.editorialPass.v1',
            mode: 'recompose',
            sourceHash: request.sourceHash,
            snapshotHash: request.snapshotHash,
            diagnosisHash: hashJson(resolvedDiagnosis),
            cardOutcomes: [],
            candidate: {
              text: 'The latch clicked. He refused to name the sender.',
              preservationLedger: [],
              changeLedger: [{ kind: 'rewrite', summary: 'Removed unsupported identity.', evidenceRefs: ['source:0'] }],
              riskFlags: []
            }
          }),
          providerId: 'editorial-test-provider',
          model: 'editorial-test-model'
        };
      }
      throw new Error(`unexpected role ${roleId}`);
    }
  }
});
const runtime = createRecursionRuntime({
  host,
  settingsStore: createSettingsStore({ root: {} }),
  storage: createStorageRepository({ storage: createMemoryStorageAdapter() }),
  activity,
  generationRouter
});
await runtime.updateSettings({ enhancements: { mode: 'recompose', applyMode: 'as-swipe' } });
const result = await runtime.enhanceLatestAssistantMessage({ reason: 'editorial-test' });
assertEqual(result.ok, true, 'recompose runtime succeeds');
assertEqual(result.mode, 'recompose', 'runtime returns editorial mode');
assertEqual(message.text, 'The latch clicked. He refused to name the sender.', 'runtime applies candidate as swipe');
assert(calls.some((call) => call.roleId === 'editorialDiagnostician'), 'runtime calls diagnostician');
assert(calls.some((call) => call.roleId === 'editorialTransformer'), 'runtime calls transformer');
assertEqual(calls.find((call) => call.roleId === 'editorialDiagnostician').request.responseSchema, 'recursion.editorialDiagnosis.v1', 'runtime sends the diagnosis response contract to the provider');
assertEqual(runtime.view().activity.severity, 'success', 'successful Editorial transform settles success');
assertEqual(runtime.view().editorialResult?.status, 'success', 'successful Editorial transform records a success result');
console.log('[pass] editorial runtime');
