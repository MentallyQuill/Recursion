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
  async snapshot() { return { chatId: 'editorial-chat', chatKey: 'editorial-chat', sceneKey: 'scene', sceneFingerprint: 'scene-fp', turnFingerprint: 'turn-fp', latestMesId: 8, messages: [{ mesid: 7, role: 'user', text: 'Keep the sender unidentified.', visible: true }, { mesid: 8, role: 'assistant', text: source, visible: true }] }; },
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
let diagnosisAttempts = 0;
const generationRouter = createGenerationRouter({
  activity,
  client: {
    async generate(roleId, request) {
      calls.push({ roleId, request });
      if (roleId === 'editorialDiagnostician') {
        diagnosisAttempts += 1;
        return {
          text: JSON.stringify({
            ...diagnosis,
            sourceHash: request.sourceHash,
            snapshotHash: request.snapshotHash,
            brief: diagnosisAttempts === 1
              ? {
                  ...diagnosis.brief,
                  preserve: [{ claim: 'Preserve the draft wording.', evidenceRefs: ['source:0'] }]
                }
              : diagnosis.brief
          }),
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
const editorialStorage = createStorageRepository({ storage: createMemoryStorageAdapter() });
const runtime = createRecursionRuntime({
  host,
  settingsStore: createSettingsStore({ root: {} }),
  storage: editorialStorage,
  activity,
  generationRouter
});
await runtime.updateSettings({ enhancements: { mode: 'recompose', applyMode: 'as-swipe' } });
const result = await runtime.enhanceLatestAssistantMessage({ reason: 'editorial-test' });
assertEqual(result.ok, true, 'recompose runtime succeeds');
assertEqual(result.mode, 'recompose', 'runtime returns editorial mode');
assertEqual(message.text, 'The latch clicked. He refused to name the sender.', 'runtime applies candidate as swipe');
const editorialJournal = await editorialStorage.loadRunJournal('editorial-chat');
const editorialSettlement = editorialJournal.entries.find((entry) => entry.event === 'editorial.run.settled');
assert(editorialSettlement, 'successful Editorial run records a terminal journal event');
assertEqual(editorialSettlement.severity, 'info', 'successful Editorial settlement is informational');
assertEqual(editorialSettlement.details.mode, 'recompose', 'Editorial settlement records mode');
assertEqual(editorialSettlement.details.status, 'success', 'Editorial settlement records status');
assertEqual(editorialSettlement.details.outcome, 'applied', 'Editorial settlement records applied outcome');
assert(calls.some((call) => call.roleId === 'editorialDiagnostician'), 'runtime calls diagnostician');
assert(calls.some((call) => call.roleId === 'editorialTransformer'), 'runtime calls transformer');
const diagnosisCalls = calls.filter((call) => call.roleId === 'editorialDiagnostician');
const diagnosisCall = diagnosisCalls[0];
const transformCall = calls.find((call) => call.roleId === 'editorialTransformer');
assertEqual(diagnosisCalls.length, 2, 'runtime uses exactly one semantic correction for invalid preservation evidence');
assert(diagnosisCalls[1].request.prompt.includes('Editorial diagnosis correction required'), 'semantic correction names the rejected diagnosis contract');
assertEqual(diagnosisCall.request.responseSchema, 'recursion.editorialDiagnosis.v1', 'runtime sends the diagnosis response contract to the provider');
assert(diagnosisCall.request.validEvidenceIds.includes('message:7'), 'runtime diagnosis request exposes bounded transcript evidence ids at the provider boundary');
assert(!diagnosisCall.request.validPreservationEvidenceIds.includes('source:0'), 'runtime excludes source-draft evidence from preservation evidence ids');
assert(transformCall.request.validEvidenceIds.includes('message:7'), 'runtime transform request preserves the same frozen evidence id set');
assert(Array.isArray(transformCall.request.installedCardIds), 'runtime transform request exposes the frozen installed-card identity set');
assertEqual(runtime.view().activity.severity, 'success', 'successful Editorial transform settles success');
assertEqual(runtime.view().editorialResult?.status, 'success', 'successful Editorial transform records a success result');

const concurrentSource = 'Mara kept one hand on the latch.';
const concurrentMessage = { messageId: 12, chatKey: 'editorial-concurrent-chat', swipeId: 0, text: concurrentSource, swipes: [concurrentSource] };
let releaseConcurrentTransform;
let concurrentTransformStarted = false;
let concurrentAppendCalls = 0;
const concurrentStorage = createStorageRepository({ storage: createMemoryStorageAdapter() });
const concurrentRuntime = createRecursionRuntime({
  host: {
    async snapshot() {
      return {
        chatId: concurrentMessage.chatKey,
        chatKey: concurrentMessage.chatKey,
        sceneKey: 'scene',
        sceneFingerprint: 'scene-fp',
        turnFingerprint: 'turn-fp',
        latestMesId: 12,
        messages: [{ mesid: 11, role: 'user', text: 'Keep Mara at the door.', visible: true }, { mesid: 12, role: 'assistant', text: concurrentSource, visible: true }]
      };
    },
    messages: {
      activeAssistantMessageIdentity() { return { ...concurrentMessage, originalHash: hashJson(concurrentMessage.text) }; },
      async holdAssistantMessage() { return { ok: true }; },
      async revealAssistantMessage() { return { ok: true }; },
      async appendAssistantMessageSwipe() { concurrentAppendCalls += 1; return { ok: true }; },
      async findEnhancedSwipe() { return null; }
    },
    prompt: { async install() { return { ok: true }; }, async clear() { return { ok: true }; } }
  },
  settingsStore: createSettingsStore({ root: {} }),
  storage: concurrentStorage,
  activity: createActivityReporter(),
  generationRouter: createGenerationRouter({
    client: {
      async generate(roleId, request) {
        if (roleId === 'editorialDiagnostician') {
          return {
            text: JSON.stringify({
              schema: 'recursion.editorialDiagnosis.v1',
              mode: 'recompose',
              sourceHash: request.sourceHash,
              snapshotHash: request.snapshotHash,
              decision: 'proceed',
              brief: {
                mode: 'recompose',
                diagnosis: [{ dimension: 'anti-slop', problem: 'The response is generic.', evidenceRefs: ['source:0'] }],
                preserve: [{ claim: 'Mara stays at the door.', evidenceRefs: ['message:11'] }],
                discard: [{ claim: 'Generic action.', evidenceRefs: ['source:0'] }],
                allowedChanges: ['Rewrite the response.'],
                forbiddenChanges: ['Do not move Mara.']
              }
            })
          };
        }
        concurrentTransformStarted = true;
        await new Promise((resolve) => { releaseConcurrentTransform = resolve; });
        return {
          text: JSON.stringify({
            schema: 'recursion.editorialPass.v1',
            mode: 'recompose',
            sourceHash: request.sourceHash,
            snapshotHash: request.snapshotHash,
            diagnosisHash: request.diagnosisHash,
            cardOutcomes: [],
            candidate: {
              text: 'Mara braced her palm against the latch.',
              preservationLedger: [{ claim: 'Mara stays at the door.', evidenceRefs: ['message:11'] }],
              changeLedger: [{ kind: 'rewrite', summary: 'Made the action concrete.', evidenceRefs: ['source:0'] }],
              riskFlags: []
            }
          })
        };
      }
    }
  })
});
await concurrentRuntime.updateSettings({ enhancements: { mode: 'recompose', applyMode: 'as-swipe' } });
const concurrentResultPromise = concurrentRuntime.enhanceLatestAssistantMessage({ reason: 'editorial-concurrent-swipe-test' });
while (!concurrentTransformStarted) await new Promise((resolve) => setTimeout(resolve, 0));
concurrentMessage.swipeId = 1;
concurrentMessage.text = 'A concurrent native swipe took ownership.';
concurrentMessage.swipes.push(concurrentMessage.text);
releaseConcurrentTransform();
const concurrentResult = await concurrentResultPromise;
assertEqual(concurrentResult.ok, false, 'Editorial rejects a commit after the active swipe changes');
assertEqual(concurrentResult.error?.code, 'RECURSION_EDITORIAL_SOURCE_CHANGED', 'Editorial reports the stale source identity');
assertEqual(concurrentAppendCalls, 0, 'Editorial never appends against a changed active swipe');
const concurrentJournal = await concurrentStorage.loadRunJournal(concurrentMessage.chatKey);
const failedSettlement = concurrentJournal.entries.find((entry) => entry.event === 'editorial.run.settled');
assert(failedSettlement, 'failed Editorial commit records a terminal journal event');
assertEqual(failedSettlement.severity, 'error', 'failed Editorial settlement records error severity');
assertEqual(failedSettlement.details.status, 'error', 'failed Editorial settlement records error status');
assertEqual(failedSettlement.details.reasonCode, 'RECURSION_EDITORIAL_SOURCE_CHANGED', 'failed Editorial settlement records the exact reason code');

const transformSource = 'Mara repeated the tactical offer while keeping her hand on the latch.';
const transformMessage = { messageId: 18, chatKey: 'editorial-transform-correction-chat', swipeId: 0, text: transformSource, swipes: [transformSource] };
const transformCalls = [];
let transformAttempts = 0;
const transformHost = {
  async snapshot() {
    return {
      chatId: transformMessage.chatKey,
      chatKey: transformMessage.chatKey,
      sceneKey: 'scene',
      sceneFingerprint: 'scene-fp',
      turnFingerprint: 'turn-fp',
      latestMesId: 18,
      messages: [
        { mesid: 17, role: 'user', text: 'Keep Mara guarded and answer the flinch.', visible: true },
        { mesid: 18, role: 'assistant', text: transformSource, visible: true }
      ]
    };
  },
  messages: {
    activeAssistantMessageIdentity() { return { ...transformMessage, originalHash: hashJson(transformSource) }; },
    async holdAssistantMessage() { transformMessage.text = ''; return { ok: true }; },
    async revealAssistantMessage() { transformMessage.text = transformSource; return { ok: true }; },
    async appendAssistantMessageSwipe(_id, text) { transformMessage.text = text; transformMessage.swipes.push(text); return { ok: true }; },
    async findEnhancedSwipe() { return null; }
  },
  prompt: { async install() { return { ok: true }; }, async clear() { return { ok: true }; } }
};
const transformCorrectionRouter = createGenerationRouter({
  client: {
    async generate(roleId, request) {
      transformCalls.push({ roleId, request });
      if (roleId === 'editorialDiagnostician') {
        return {
          text: JSON.stringify({
            schema: 'recursion.editorialDiagnosis.v1',
            mode: 'recompose',
            sourceHash: request.sourceHash,
            snapshotHash: request.snapshotHash,
            decision: 'proceed',
            brief: {
              mode: 'recompose',
              diagnosis: [{ dimension: 'anti-slop', problem: 'The response repeats the offer.', evidenceRefs: ['source:0'] }],
              preserve: [{ claim: 'Mara remains guarded.', evidenceRefs: ['message:17'] }],
              discard: [{ claim: 'Repeated offer wording.', evidenceRefs: ['source:0'] }],
              allowedChanges: ['Rewrite the response.'],
              forbiddenChanges: ['Do not soften Mara.']
            }
          })
        };
      }
      transformAttempts += 1;
      return {
        text: JSON.stringify({
          schema: 'recursion.editorialPass.v1',
          mode: 'recompose',
          sourceHash: request.sourceHash,
          snapshotHash: request.snapshotHash,
          diagnosisHash: request.diagnosisHash,
          cardOutcomes: [],
          candidate: {
            text: 'Mara watched the flinch without easing her grip on the latch.',
            preservationLedger: [{
              claim: 'Mara remains guarded.',
              evidenceRefs: [transformAttempts === 1 ? 'source:0' : 'message:17']
            }],
            changeLedger: [{ kind: 'rewrite', summary: 'Removed the repeated offer.', evidenceRefs: ['source:0'] }],
            riskFlags: []
          }
        })
      };
    }
  }
});
const transformCorrectionRuntime = createRecursionRuntime({
  host: transformHost,
  settingsStore: createSettingsStore({ root: {} }),
  storage: createStorageRepository({ storage: createMemoryStorageAdapter() }),
  activity: createActivityReporter(),
  generationRouter: transformCorrectionRouter
});
await transformCorrectionRuntime.updateSettings({ enhancements: { mode: 'recompose', applyMode: 'as-swipe' } });
const transformCorrectionResult = await transformCorrectionRuntime.enhanceLatestAssistantMessage({ reason: 'editorial-transform-correction-test' });
assertEqual(transformCorrectionResult.ok, true, 'runtime corrects invalid candidate preservation evidence');
const transformerCalls = transformCalls.filter((call) => call.roleId === 'editorialTransformer');
assertEqual(transformerCalls.length, 2, 'runtime uses exactly one semantic correction for invalid candidate evidence');
assert(transformerCalls[1].request.prompt.includes('Editorial pass correction required'), 'transform semantic correction names the rejected pass contract');

const failedSource = 'Mara kept her hand on the latch.';
const failedMessage = { messageId: 28, chatKey: 'editorial-transform-failure-chat', swipeId: 0, text: failedSource, swipes: [failedSource] };
const failedActivity = createActivityReporter();
const failedRuntime = createRecursionRuntime({
  host: {
    async snapshot() {
      return {
        chatId: failedMessage.chatKey,
        chatKey: failedMessage.chatKey,
        sceneKey: 'scene',
        sceneFingerprint: 'scene-fp',
        turnFingerprint: 'turn-fp',
        latestMesId: 28,
        messages: [
          { mesid: 27, role: 'user', text: 'Keep Mara guarded.', visible: true },
          { mesid: 28, role: 'assistant', text: failedSource, visible: true }
        ]
      };
    },
    messages: {
      activeAssistantMessageIdentity() { return { ...failedMessage, originalHash: hashJson(failedSource) }; },
      async holdAssistantMessage() { failedMessage.text = ''; return { ok: true }; },
      async revealAssistantMessage() { failedMessage.text = failedSource; return { ok: true }; },
      async findEnhancedSwipe() { return null; }
    },
    prompt: { async install() { return { ok: true }; }, async clear() { return { ok: true }; } }
  },
  settingsStore: createSettingsStore({ root: {} }),
  storage: createStorageRepository({ storage: createMemoryStorageAdapter() }),
  activity: failedActivity,
  generationRouter: {
    async generate(roleId, request) {
      if (roleId === 'editorialDiagnostician') {
        return {
          ok: true,
          data: {
            schema: 'recursion.editorialDiagnosis.v1',
            mode: 'recompose',
            sourceHash: request.sourceHash,
            snapshotHash: request.snapshotHash,
            decision: 'proceed',
            brief: {
              mode: 'recompose',
              diagnosis: [{ dimension: 'anti-slop', problem: 'Tighten the response.', evidenceRefs: ['source:0'] }],
              preserve: [],
              discard: [{ claim: 'Draft wording may change.', evidenceRefs: ['source:0'] }],
              allowedChanges: ['Rewrite the response.'],
              forbiddenChanges: ['Do not soften Mara.']
            }
          }
        };
      }
      return {
        ok: false,
        error: {
          code: 'RECURSION_PROVIDER_TOKEN_LIMIT',
          message: 'Provider response stopped at the token limit.'
        }
      };
    }
  }
});
await failedRuntime.updateSettings({ enhancements: { mode: 'recompose', applyMode: 'as-swipe' } });
const failedResult = await failedRuntime.enhanceLatestAssistantMessage({ reason: 'editorial-transform-provider-failure-test' });
assertEqual(failedResult.ok, false, 'transform provider failure returns failure');
assertEqual(failedRuntime.view().editorialResult?.status, 'error', 'transform provider failure settles Editorial result');
assertEqual(failedRuntime.view().activity.phase, 'settled', 'transform provider failure settles activity');
assertEqual(failedRuntime.view().activity.severity, 'error', 'transform provider failure remains visibly unhealthy');
assertEqual(failedMessage.text, failedSource, 'transform provider failure restores the original assistant text');

const noChangeSource = 'Mara answered the immediate question without changing her guarded posture.';
const noChangeMessage = { messageId: 38, chatKey: 'editorial-no-change-chat', swipeId: 0, text: noChangeSource, swipes: [noChangeSource] };
let noChangeTransformerCalls = 0;
const noChangeRuntime = createRecursionRuntime({
  host: {
    async snapshot() {
      return {
        chatId: noChangeMessage.chatKey,
        chatKey: noChangeMessage.chatKey,
        sceneKey: 'scene',
        sceneFingerprint: 'scene-fp',
        turnFingerprint: 'turn-fp',
        latestMesId: 38,
        messages: [
          { mesid: 37, role: 'user', text: 'Answer the immediate question and keep Mara guarded.', visible: true },
          { mesid: 38, role: 'assistant', text: noChangeSource, visible: true }
        ]
      };
    },
    messages: {
      activeAssistantMessageIdentity() { return { ...noChangeMessage, originalHash: hashJson(noChangeSource) }; },
      async holdAssistantMessage() { noChangeMessage.text = ''; return { ok: true }; },
      async revealAssistantMessage() { noChangeMessage.text = noChangeSource; return { ok: true }; },
      async findEnhancedSwipe() { return null; }
    },
    prompt: { async install() { return { ok: true }; }, async clear() { return { ok: true }; } }
  },
  settingsStore: createSettingsStore({ root: {} }),
  storage: createStorageRepository({ storage: createMemoryStorageAdapter() }),
  activity: createActivityReporter(),
  generationRouter: {
    async generate(roleId, request) {
      if (roleId !== 'editorialDiagnostician') {
        noChangeTransformerCalls += 1;
        return { ok: false, error: { code: 'UNEXPECTED_TRANSFORM', message: 'Transformer should not run.' } };
      }
      return {
        ok: true,
        data: {
          schema: 'recursion.editorialDiagnosis.v1',
          mode: 'recompose',
          sourceHash: request.sourceHash,
          snapshotHash: request.snapshotHash,
          decision: 'no-change',
          brief: {
            mode: 'recompose',
            diagnosis: [],
            preserve: [{ claim: 'The response answers the immediate question.', evidenceRefs: ['message:37'] }],
            discard: [],
            allowedChanges: [],
            forbiddenChanges: ['Do not soften Mara.']
          }
        }
      };
    }
  }
});
await noChangeRuntime.updateSettings({ enhancements: { mode: 'recompose', applyMode: 'as-swipe' } });
const noChangeResult = await noChangeRuntime.enhanceLatestAssistantMessage({ reason: 'editorial-no-change-test' });
assertEqual(noChangeResult.ok, true, 'validated no-change diagnosis is a successful skip');
assertEqual(noChangeResult.skipped, true, 'validated no-change diagnosis does not mutate the response');
assertEqual(noChangeRuntime.view().editorialResult?.status, 'success', 'validated no-change diagnosis settles Editorial green');
assertEqual(noChangeRuntime.view().activity.severity, 'success', 'validated no-change diagnosis keeps prompt readiness green');
assertEqual(noChangeTransformerCalls, 0, 'validated no-change diagnosis does not call transformer');
assertEqual(noChangeMessage.text, noChangeSource, 'validated no-change diagnosis preserves original assistant text');
console.log('[pass] editorial runtime');
