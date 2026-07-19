import { createRecursionRuntime } from '../../src/runtime.mjs';
import { createSettingsStore } from '../../src/settings.mjs';
import { createMemoryStorageAdapter, createStorageRepository } from '../../src/storage.mjs';
import { createActivityReporter } from '../../src/activity.mjs';
import { createGenerationRouter } from '../../src/providers.mjs';
import { providerConfigHash } from '../../src/provider-capability.mjs';
import { hashJson } from '../../src/core.mjs';
import { REDIRECT_ERROR_CODES, REDIRECT_VERIFICATION_CHECKS } from '../../src/editorial-transform.mjs';
import { buildGenerationReviewTargets } from '../../src/generation-review.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

function createLegacyEnhancementSettingsStore() {
  const settingsStore = createSettingsStore({ root: {} });
  let enhancements = { mode: 'off', target: 'off', applyMode: 'as-swipe', contextMessages: 13 };
  const canonicalGet = settingsStore.get.bind(settingsStore);
  const canonicalUpdate = settingsStore.update.bind(settingsStore);
  settingsStore.get = () => ({ ...canonicalGet(), enhancements: { ...enhancements } });
  settingsStore.update = (patch = {}) => {
    if (patch.enhancements && typeof patch.enhancements === 'object') {
      enhancements = { ...enhancements, ...patch.enhancements };
      if (enhancements.mode !== 'off') enhancements.target = 'on';
    }
    const { enhancements: ignoredEnhancements, ...canonicalPatch } = patch;
    return { ...canonicalUpdate(canonicalPatch), enhancements: { ...enhancements } };
  };
  return settingsStore;
}

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
  settingsStore: createLegacyEnhancementSettingsStore(),
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
const callsAfterEditorialSettlement = calls.length;
const duplicateAssistantLanded = await runtime.enhanceLatestAssistantMessage({ reason: 'assistant-message-landed' });
assertEqual(duplicateAssistantLanded.reason, 'enhancement-not-armed', 'runtime rejects an assistant-landed Enhancement without a generation authorization');
assertEqual(calls.length, callsAfterEditorialSettlement, 'unarmed assistant-landed Enhancement makes no provider call');

const pendingCommitSource = 'Mara kept her answer brief and watched the sealed door.';
const pendingCommitMessage = { messageId: 10, chatKey: 'editorial-pending-commit-chat', swipeId: 0, text: pendingCommitSource, swipes: [pendingCommitSource] };
let signalAppendEntered;
let releaseAppend;
const appendEntered = new Promise((resolve) => { signalAppendEntered = resolve; });
const pendingCommitRuntime = createRecursionRuntime({
  host: {
    async snapshot() {
      return {
        chatId: pendingCommitMessage.chatKey,
        chatKey: pendingCommitMessage.chatKey,
        sceneKey: 'scene',
        sceneFingerprint: 'scene-fp',
        turnFingerprint: 'turn-fp',
        latestMesId: pendingCommitMessage.messageId,
        messages: [
          { mesid: 9, role: 'user', text: 'Keep the sender unidentified.', visible: true },
          { mesid: pendingCommitMessage.messageId, role: 'assistant', text: pendingCommitSource, visible: true }
        ]
      };
    },
    messages: {
      activeAssistantMessageIdentity() { return { ...pendingCommitMessage, originalHash: hashJson(pendingCommitSource) }; },
      async holdAssistantMessage() { return { ok: true }; },
      async revealAssistantMessage() { return { ok: true }; },
      async appendAssistantMessageSwipe(_id, text) {
        signalAppendEntered();
        return await new Promise((resolve) => {
          releaseAppend = () => {
            pendingCommitMessage.text = text;
            pendingCommitMessage.swipes.push(text);
            resolve({ ok: true });
          };
        });
      },
      async findEnhancedSwipe() { return null; }
    },
    prompt: { async install() { return { ok: true }; }, async clear() { return { ok: true }; } }
  },
  settingsStore: createLegacyEnhancementSettingsStore(),
  storage: createStorageRepository({ storage: createMemoryStorageAdapter() }),
  activity: createActivityReporter(),
  generationRouter
});
await pendingCommitRuntime.updateSettings({ enhancements: { mode: 'recompose', applyMode: 'as-swipe' } });
const pendingCommitRun = pendingCommitRuntime.enhanceLatestAssistantMessage({ reason: 'editorial-pending-commit-test' });
await appendEntered;
assert(pendingCommitRuntime.view().editorialResult?.status !== 'success', 'Editorial success is not observable before the host swipe append settles');
releaseAppend();
assertEqual((await pendingCommitRun).ok, true, 'Editorial run succeeds after the host swipe append settles');
assertEqual(pendingCommitRuntime.view().editorialResult?.status, 'success', 'Editorial success becomes visible after the host swipe append settles');

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
  settingsStore: createLegacyEnhancementSettingsStore(),
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
  settingsStore: createLegacyEnhancementSettingsStore(),
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

{
  const repairSource = 'The waitress repeated the same motion. Teal watched the loop without blinking.';
  const repairTargets = buildGenerationReviewTargets(repairSource);
  const repairTarget = repairTargets.prose[0];
  const repairMessage = {
    messageId: 2,
    chatKey: 'editorial-repair-card-coverage-chat',
    swipeId: 0,
    text: repairSource,
    swipes: [repairSource]
  };
  let repairSnapshot = {
    chatId: repairMessage.chatKey,
    chatKey: repairMessage.chatKey,
    sceneKey: 'scene',
    sceneFingerprint: 'scene-fp',
    turnFingerprint: 'turn-fp',
    latestMesId: 1,
    messages: [{ mesid: 1, role: 'user', text: 'Keep the diner loop grounded.', visible: true }]
  };
  const repairDiagnosisOptions = [];
  let repairTransformAttempts = 0;
  const repairTransformOptions = [];
  let repairAuditAttempts = 0;
  const repairVerifierRouter = createGenerationRouter({
    client: {
      async generate() {
        repairAuditAttempts += 1;
        return {
          text: JSON.stringify({
            schema: 'recursion.editorialVerification.v1',
            failedCardIds: repairAuditAttempts === 1 ? ['unknown-card'] : [],
            reason: repairAuditAttempts === 1
              ? 'Malformed dynamic failed-card coverage.'
              : 'Every installed card is satisfied.'
          })
        };
      }
    }
  });
  const appendedRepairSwipes = [];
  const repairStorage = createStorageRepository({ storage: createMemoryStorageAdapter() });
  const repairRuntime = createRecursionRuntime({
    host: {
      async snapshot() { return repairSnapshot; },
      messages: {
        activeAssistantMessageIdentity() {
          return { ...repairMessage, originalHash: hashJson(repairSource) };
        },
        async holdAssistantMessage() {
          repairMessage.text = '';
          return { ok: true };
        },
        async revealAssistantMessage() {
          repairMessage.text = repairSource;
          return { ok: true };
        },
        async appendAssistantMessageSwipe(_id, text, options) {
          repairMessage.text = text;
          repairMessage.swipes.push(text);
          appendedRepairSwipes.push({ text, options });
          return { ok: true };
        },
        async findEnhancedSwipe() { return null; }
      },
      prompt: {
        async install() { return { ok: true, installed: true }; },
        async clear() { return { ok: true, cleared: true }; }
      }
    },
    settingsStore: createLegacyEnhancementSettingsStore(),
    storage: repairStorage,
    activity: createActivityReporter(),
    generationRouter: {
      async generate(roleId, request, options = {}) {
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: 'recursion.utilityArbiter.v1',
              snapshotHash: request.snapshotHash,
              action: 'refresh-cards',
              cardJobs: [{ role: 'sceneFrameCard', family: 'Scene Frame' }],
              budgets: { targetBriefTokens: 500, maxCards: 1 },
              reasonerDecision: { mode: 'skip', reason: 'repair coverage regression' }
            }
          };
        }
        if (roleId === 'sceneFrameCard') {
          return {
            ok: true,
            data: {
              schema: 'recursion.card.v1',
              role: 'sceneFrameCard',
              family: 'Scene Frame',
              snapshotHash: request.snapshotHash,
              items: [{
                promptText: 'Keep the diner loop and active cast grounded.',
                evidenceRefs: ['message:1'],
                tokenEstimate: 8
              }]
            }
          };
        }
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'Keep the diner loop grounded.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: []
            }
          };
        }
        if (roleId === 'editorialDiagnostician') {
          repairDiagnosisOptions.push(options);
          return {
            ok: true,
            recoverySpent: options.allowStructuredRecovery === false,
            data: {
              schema: 'recursion.editorialDiagnosis.v1',
              mode: 'repair',
              sourceHash: request.sourceHash,
              snapshotHash: request.snapshotHash,
              decision: 'proceed',
              brief: {
                mode: 'repair',
                diagnosis: [{
                  dimension: 'anti-slop',
                  problem: 'The repeated-motion sentence is flat.',
                  evidenceRefs: ['source:0']
                }],
                preserve: [],
                discard: [{ claim: 'Flat repeated-motion wording.', evidenceRefs: ['source:0'] }],
                allowedChanges: ['Repair the first sentence.'],
                forbiddenChanges: ['Do not alter the diner-loop fact.']
              }
            }
          };
        }
        if (roleId === 'editorialTransformer') {
          repairTransformOptions.push(options);
          repairTransformAttempts += 1;
          return {
            ok: true,
            recoverySpent: options.allowStructuredRecovery === false,
            data: {
              schema: 'recursion.editorialPass.v1',
              mode: 'repair',
              sourceHash: request.sourceHash,
              snapshotHash: request.snapshotHash,
              diagnosisHash: request.diagnosisHash,
              cardOutcomes: [],
              patches: repairTransformAttempts === 1
                ? []
                : [{
                    id: repairTarget.id,
                    before: repairTarget.before,
                    after: 'The waitress reset the same table with the precision of a machine.',
                    domain: 'narrative-execution',
                    evidenceRefs: ['source:0']
                  }]
            }
          };
        }
        if (roleId === 'editorialVerifier') {
          return repairVerifierRouter.generate(roleId, request, {
            allowStructuredRecovery: false,
            maxAttempts: 1
          });
        }
        throw new Error(`unexpected repair coverage role ${roleId}`);
      }
    }
  });
  const prepared = await repairRuntime.prepareForGeneration({ hostGeneration: true });
  assertEqual(prepared.ok, true, 'repair coverage setup installs a prompt packet');
  assert(repairRuntime.view().lastPreparedGeneration?.hand?.cards?.length > 0, 'repair coverage setup has an installed card obligation');
  repairSnapshot = {
    ...repairSnapshot,
    latestMesId: 2,
    messages: [
      ...repairSnapshot.messages,
      { mesid: 2, role: 'assistant', text: repairSource, visible: true }
    ]
  };
  await repairRuntime.updateSettings({ enhancements: { mode: 'repair', applyMode: 'as-swipe' } });
  const repaired = await repairRuntime.enhanceLatestAssistantMessage({ reason: 'repair-card-coverage-regression' });
  assertEqual(repairDiagnosisOptions[0]?.allowStructuredRecovery, false, 'Repair reserves diagnosis recovery for runtime semantic correction');
  assertEqual(repairTransformAttempts, 2, 'Repair uses exactly one runtime semantic correction for an empty bounded-patch list');
  assertEqual(
    repairTransformOptions[0]?.allowStructuredRecovery,
    false,
    'Repair reserves its single recovery call for a runtime-owned semantic transform correction'
  );
  assert(
    repairTransformOptions[1]?.allowStructuredRecovery === false,
    'Repair semantic transform correction keeps provider-layer structured recovery disabled'
  );
  assertEqual(repairAuditAttempts, 2, 'Repair corrects one raw unknown-ID compact card audit through the provider normalizer');
  assertEqual(repaired.ok, true, 'Repair applies bounded patches after corrected card-audit coverage');
  assertEqual(repaired.partialFailed, false, 'accepted corrected card audit resolves recovered card coverage');
  assertEqual(appendedRepairSwipes.length, 1, 'corrected Repair appends exactly one safe swipe');
  assertEqual(repairRuntime.view().editorialResult?.status, 'success', 'corrected Repair settles visibly healthy');
  assertDeepEqual(
    repairRuntime.view().activity?.detail?.unresolvedCardIds,
    repaired.unresolvedCardIds,
    'corrected Repair clears dynamic unresolved installed-card IDs'
  );
  assertDeepEqual(
    repairRuntime.view().activity?.detail?.cardOutcomes,
    repaired.marker.cardOutcomes,
    'corrected Repair exposes the accepted dynamic card ledger to progress rendering'
  );
  assert(
    repaired.marker.cardOutcomes.every((outcome) => outcome.status === 'honored'),
    'corrected Repair preserves locally derived accepted card outcomes'
  );
  const repairJournal = await repairStorage.loadRunJournal(repairMessage.chatKey);
  const repairSettlement = repairJournal.entries.find((entry) => entry.event === 'editorial.run.settled');
  assertEqual(repairSettlement.severity, 'info', 'corrected Repair persists a healthy terminal severity');
  assertEqual(repairSettlement.details.status, 'success', 'corrected Repair persists its exact terminal status');
}

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
  settingsStore: createLegacyEnhancementSettingsStore(),
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
  settingsStore: createLegacyEnhancementSettingsStore(),
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
assertEqual(noChangeRuntime.view().editorialResult?.status, 'skipped', 'validated no-change diagnosis records a skipped Editorial outcome');
assertEqual(noChangeRuntime.view().activity.outcome, 'skipped', 'validated no-change diagnosis does not masquerade as an applied Enhancement');
assertEqual(noChangeRuntime.view().activity.label, 'Editorial complete; no changes needed.', 'validated no-change diagnosis explains why no swipe was added');
assertEqual(noChangeTransformerCalls, 0, 'validated no-change diagnosis does not call transformer');
assertEqual(noChangeMessage.text, noChangeSource, 'validated no-change diagnosis preserves original assistant text');

const redirectSource = 'Carter considered the request, but postponed the test until later.';
const redirectCandidateText = 'Carter tightened her grip on the mug. "Then we test it here," she said, holding Will to the immediate question.';
const privateRedirectSentinel = 'PRIVATE_REDIRECT_PRESSURE_SENTINEL';
function createRedirectHarness({
  verifierDecision = 'accept',
  verifierDecisions = null,
  verifierChecks = null,
  verifierChecksByAttempt = null,
  appendFailure = false,
  changeSourceAfterVerifier = false,
  cachedMarkerFactory = null,
  diagnosisOverride = null,
  diagnosisProviderFailureOnFirst = false,
  transformProviderFailures = 0,
  candidateOverride = null,
  reasonerCapability = 'ready',
  mutateReasonerAfterDiagnosis = false,
  pressureReason = 'The source blocks the immediate test.'
} = {}) {
  const state = {
    calls: [],
    diagnosisAttempts: 0,
    transformAttempts: 0,
    verifierAttempts: 0,
    appended: [],
    selected: [],
    activityEvents: [],
    persistedMarker: null,
    reusePersisted: false,
    verifierFinished: false,
    message: { messageId: 48, chatKey: `redirect-runtime-${Math.random()}`, swipeId: 0, text: redirectSource, swipes: [redirectSource] }
  };
  const storage = createStorageRepository({ storage: createMemoryStorageAdapter() });
  const activity = createActivityReporter({
    onEvent(event) {
      state.activityEvents.push(event);
    }
  });
  const host = {
    async snapshot() {
      return {
        chatId: state.message.chatKey,
        chatKey: state.message.chatKey,
        sceneKey: 'diner',
        sceneFingerprint: 'diner-fp',
        turnFingerprint: 'turn-fp',
        latestMesId: state.message.messageId,
        messages: [
          { mesid: 47, role: 'user', text: 'Carter wants to test the transport method now and needs Will to answer directly.', visible: true },
          { mesid: 48, role: 'assistant', text: redirectSource, visible: true }
        ]
      };
    },
    messages: {
      activeAssistantMessageIdentity() {
        return {
          ...state.message,
          swipeId: changeSourceAfterVerifier && state.verifierFinished ? 1 : state.message.swipeId,
          originalHash: hashJson(redirectSource)
        };
      },
      async holdAssistantMessage() { return { ok: true }; },
      async revealAssistantMessage() { return { ok: true }; },
      async appendAssistantMessageSwipe(_id, text, options) {
        state.appended.push({ text, options });
        if (appendFailure) return { ok: false, error: { code: 'RECURSION_TEST_APPEND_FAILED', message: 'Swipe append failed.' } };
        state.persistedMarker = options.marker;
        return { ok: true, index: 1, text };
      },
      async findEnhancedSwipe(_id, marker) {
        if (typeof cachedMarkerFactory === 'function') {
          return { index: 1, text: redirectCandidateText, marker: cachedMarkerFactory(marker) };
        }
        if (!state.reusePersisted || !state.persistedMarker) return null;
        return { index: 1, text: redirectCandidateText, marker: state.persistedMarker };
      },
      async selectAssistantMessageSwipe(_id, index, options) {
        state.selected.push({ index, options });
        return { ok: true, index };
      }
    },
    prompt: { async install() { return { ok: true }; }, async clear() { return { ok: true }; } }
  };
  let settingsStore = null;
  const generationRouter = {
    async generate(roleId, request, options) {
      state.calls.push({ roleId, request, options });
      if (roleId === 'utilityArbiter') {
        return {
          ok: true,
          data: {
            schema: 'recursion.utilityArbiter.v1',
            snapshotHash: request.snapshotHash,
            action: 'skip',
            sceneStatus: 'same-scene',
            cardJobs: [],
            reasonerDecision: { mode: 'skip', reason: 'Redirect capability preflight fixture.', signals: [] },
            budgets: { targetBriefTokens: 500, maxCards: 4 },
            diagnostics: ['redirect-capability-preflight']
          }
        };
      }
      if (roleId === 'editorialDiagnostician') {
        state.diagnosisAttempts += 1;
        if (diagnosisProviderFailureOnFirst && state.diagnosisAttempts === 1) {
          return {
            ok: false,
            recoverySpent: true,
            error: {
              code: 'RECURSION_PROVIDER_RESPONSE_INVALID',
              message: 'Editorial diagnosis response failed structured-output validation.'
            }
          };
        }
        const diagnosis = {
          schema: 'recursion.editorialDiagnosis.v1',
          mode: 'redirect',
          sourceHash: request.sourceHash,
          snapshotHash: request.snapshotHash,
          decision: 'proceed',
          sourceFailure: {
            category: 'turn-fulfillment',
            problem: 'The source postpones the requested test.',
            establishedEvidenceRefs: ['message:47'],
            conflictingSourceRefs: ['source:0']
          },
          replacementObjective: { summary: 'Engage the proposed test now.', evidenceRefs: ['message:47'] },
          requiredBeats: [{ summary: 'Carter presses for the immediate test.', evidenceRefs: ['message:47'] }],
          forbiddenSourceBeats: [{ summary: 'Do not postpone the test.', sourceRefs: ['source:0'] }],
          sceneCharacters: [{ character: 'Carter', evidenceRefs: ['message:47'] }],
          characterPressure: [{
            character: 'Carter',
            immediateWant: 'Test the transport method now.',
            wantEvidenceRefs: ['message:47'],
            sourcePressureEffect: 'increasing',
            sourceEvidenceRefs: ['source:0'],
            pressureReason
          }]
        };
        if (mutateReasonerAfterDiagnosis) {
          settingsStore.updateProviderConfig('reasoner', { maxTokens: 4096 });
        }
        return {
          ok: true,
          data: typeof diagnosisOverride === 'function'
            ? diagnosisOverride(diagnosis, state.diagnosisAttempts)
            : diagnosis
        };
      }
      if (roleId === 'editorialTransformer') {
        state.transformAttempts += 1;
        if (state.transformAttempts <= transformProviderFailures) {
          return {
            ok: false,
            error: {
              code: 'RECURSION_PROVIDER_TIMEOUT',
              message: 'Editorial transformer provider timed out.'
            }
          };
        }
        const pass = {
          schema: 'recursion.editorialPass.v1',
          mode: 'redirect',
          sourceHash: request.sourceHash,
          snapshotHash: request.snapshotHash,
          diagnosisHash: request.diagnosisHash,
          cardOutcomes: [],
          candidate: {
            text: redirectCandidateText,
            preservationLedger: [],
            changeLedger: [{ kind: 'redirect', summary: 'Engaged the test in the present turn.', evidenceRefs: ['message:47'] }],
            riskFlags: []
          }
        };
        return {
          ok: true,
          data: typeof candidateOverride === 'function'
            ? candidateOverride(pass, state.transformAttempts)
            : pass
        };
      }
      if (roleId === 'editorialVerifier') {
        state.verifierAttempts += 1;
        state.verifierFinished = true;
        const currentVerifierDecision = Array.isArray(verifierDecisions)
          ? verifierDecisions[state.verifierAttempts - 1] || verifierDecisions.at(-1)
          : verifierDecision;
        const currentVerifierChecks = Array.isArray(verifierChecksByAttempt)
          ? verifierChecksByAttempt[state.verifierAttempts - 1] || verifierChecksByAttempt.at(-1)
          : verifierChecks;
        return {
          ok: true,
          data: {
            schema: 'recursion.editorialVerification.v1',
            mode: 'redirect',
            sourceHash: request.sourceHash,
            snapshotHash: request.snapshotHash,
            diagnosisHash: request.diagnosisHash,
            candidateHash: request.candidateHash,
            decision: currentVerifierDecision,
            checks: currentVerifierChecks || REDIRECT_VERIFICATION_CHECKS.map((check) => ({
              check,
              status: currentVerifierDecision === 'accept' ? 'pass' : 'unclear',
              evidenceRefs: ['message:47'],
              note: currentVerifierDecision === 'accept'
                ? 'Bound to frozen evidence.'
                : `Candidate still fails ${check}.`
            }))
          }
        };
      }
      throw new Error(`Unexpected Redirect role ${roleId}`);
    }
  };
  settingsStore = createLegacyEnhancementSettingsStore();
  if (reasonerCapability === 'unconfigured') {
    settingsStore.updateProviderConfig('reasoner', {
      source: 'host-connection-profile',
      hostConnectionProfileId: ''
    });
  } else if (reasonerCapability === 'ready' || reasonerCapability === 'unhealthy') {
    const reasoner = settingsStore.get().providers.reasoner;
    settingsStore.recordProviderHealth('reasoner', {
      status: reasonerCapability === 'ready' ? 'pass' : 'fail',
      checkedAt: new Date().toISOString(),
      errorCode: reasonerCapability === 'unhealthy' ? 'RECURSION_TEST_PROVIDER_FAILED' : '',
      message: reasonerCapability === 'unhealthy' ? 'Reasoner health check failed.' : ''
    }, {
      configHash: providerConfigHash(reasoner),
      configRevision: reasoner.configRevision
    });
  }
  const runtime = createRecursionRuntime({
    host,
    settingsStore,
    storage,
    activity,
    generationRouter
  });
  return { runtime, state, storage };
}

const acceptedRedirect = createRedirectHarness({ pressureReason: privateRedirectSentinel });
await acceptedRedirect.runtime.updateSettings({ reasoningLevel: 'medium', enhancements: { mode: 'redirect', applyMode: 'replace' } });
const acceptedRedirectResult = await acceptedRedirect.runtime.enhanceLatestAssistantMessage({ reason: 'redirect-runtime-test' });
assertEqual(acceptedRedirectResult.ok, true, 'Medium Redirect succeeds after mandatory verification');
assertEqual(acceptedRedirect.state.calls.length, 3, 'successful Redirect uses exactly diagnosis, transform, and verifier calls');
const redirectVerifierCalls = acceptedRedirect.state.calls.filter((call) => call.roleId === 'editorialVerifier');
const redirectDiagnosisCall = acceptedRedirect.state.calls.find((call) => call.roleId === 'editorialDiagnostician');
assertEqual(redirectDiagnosisCall.request.reasoningIntent, 'low', 'Redirect diagnosis starts with low reasoning to protect its structured output budget');
assertEqual(redirectVerifierCalls.length, 1, 'Medium Redirect always calls the verifier');
assertEqual(redirectVerifierCalls[0].request.candidateHash, hashJson(redirectCandidateText), 'runtime verifier binds the exact candidate hash');
assert(redirectVerifierCalls[0].request.diagnosis?.brief, 'runtime verifier request retains the validated Redirect diagnosis');
assertEqual(
  redirectVerifierCalls[0].request.diagnosis.brief.requiredBeats[0].summary,
  'Carter presses for the immediate test.',
  'runtime verifier receives the required beat it must judge'
);
assertEqual(
  redirectVerifierCalls[0].request.diagnosis.brief.characterPressure[0].sourcePressureEffect,
  'increasing',
  'runtime verifier receives the private character-pressure finding it must judge'
);

const decayedRedirect = createRedirectHarness({ mutateReasonerAfterDiagnosis: true });
await decayedRedirect.runtime.updateSettings({ reasoningLevel: 'medium', enhancements: { mode: 'redirect', applyMode: 'as-swipe' } });
const decayedRedirectResult = await decayedRedirect.runtime.enhanceLatestAssistantMessage({ reason: 'redirect-capability-decay-test' });
assertEqual(decayedRedirectResult.ok, true, 'Redirect capability decay settles as a safe skip');
assertEqual(decayedRedirectResult.skipped, true, 'Redirect capability decay does not continue Editorial');
assertEqual(decayedRedirect.state.calls.length, 1, 'configuration change after diagnosis prevents writer and verifier calls');
assertEqual(decayedRedirect.state.appended.length, 0, 'configuration change after diagnosis preserves the original response');
assertEqual(acceptedRedirectResult.marker.applyMode, 'as-swipe', 'Redirect forces swipe application');
assertEqual(acceptedRedirectResult.marker.verification, 'accept', 'accepted verifier status persists');
assertEqual(acceptedRedirectResult.marker.redirect.characterPressure[0].character, 'Carter', 'private pressure audit persists in the marker');
assert(JSON.stringify(acceptedRedirectResult.marker).includes(privateRedirectSentinel), 'private pressure sentinel persists in Recursion-owned marker metadata');
assert(!acceptedRedirect.state.appended[0].text.includes(privateRedirectSentinel), 'private pressure sentinel is absent from assistant prose');
assert(!JSON.stringify(acceptedRedirect.runtime.view()).includes(privateRedirectSentinel), 'private pressure sentinel is absent from runtime view state');
assert(!JSON.stringify(acceptedRedirect.runtime.view().lastBrief || {}).includes(privateRedirectSentinel), 'private pressure sentinel is absent from Last Brief');
assert(!JSON.stringify(acceptedRedirect.runtime.view().lastPacket || {}).includes(privateRedirectSentinel), 'private pressure sentinel is absent from Prompt Packet state');
assertEqual(acceptedRedirect.state.appended.length, 1, 'accepted Redirect appends exactly one swipe');
const acceptedRedirectJournal = await acceptedRedirect.storage.loadRunJournal(acceptedRedirect.state.message.chatKey);
const acceptedRedirectSettlement = acceptedRedirectJournal.entries.find((entry) => entry.event === 'editorial.run.settled');
assertEqual(acceptedRedirectSettlement.details.redirectCharacterCount, 1, 'Redirect journal records character count only');
assertEqual(acceptedRedirectSettlement.details.redirectRequiredBeatCount, 1, 'Redirect journal records required-beat count only');
assert(!JSON.stringify(acceptedRedirectSettlement).includes(privateRedirectSentinel), 'Redirect journal excludes private pressure text');

const reasonerVerifiedRedirect = createRedirectHarness({ reasonerCapability: 'ready' });
await reasonerVerifiedRedirect.runtime.updateSettings({ reasoningLevel: 'medium', enhancements: { mode: 'redirect', applyMode: 'as-swipe' } });
const reasonerVerifiedResult = await reasonerVerifiedRedirect.runtime.enhanceLatestAssistantMessage({ reason: 'redirect-reasoner-verifier-test' });
assertEqual(reasonerVerifiedResult.ok, true, 'Medium Redirect succeeds with an independent healthy Reasoner verifier');
assertEqual(
  reasonerVerifiedRedirect.state.calls.find((call) => call.roleId === 'editorialDiagnostician')?.request?.lane,
  'utility',
  'Medium Redirect diagnosis remains on Utility'
);
assertEqual(
  reasonerVerifiedRedirect.state.calls.find((call) => call.roleId === 'editorialTransformer')?.request?.lane,
  'reasoner',
  'Medium Redirect transformation is written by Reasoner'
);
assertEqual(
  reasonerVerifiedRedirect.state.calls.find((call) => call.roleId === 'editorialVerifier')?.request?.lane,
  'reasoner',
  'Redirect verification prefers a healthy independent Reasoner'
);

const lowUtilityRedirect = createRedirectHarness({ reasonerCapability: 'untested' });
await lowUtilityRedirect.runtime.updateSettings({ reasoningLevel: 'low', enhancements: { mode: 'redirect', applyMode: 'as-swipe' } });
const lowUtilityResult = await lowUtilityRedirect.runtime.enhanceLatestAssistantMessage({ reason: 'redirect-low-utility-writer-test' });
assertEqual(lowUtilityResult.ok, true, 'Low Redirect succeeds with a Utility writer');
assertEqual(
  lowUtilityRedirect.state.calls.find((call) => call.roleId === 'editorialTransformer')?.request?.lane,
  'utility',
  'Low Redirect final writing stays on Utility'
);

for (const reasonerCapability of ['unconfigured', 'untested', 'unhealthy']) {
  const blockedMediumRedirect = createRedirectHarness({ reasonerCapability });
  await blockedMediumRedirect.runtime.updateSettings({
    reasoningLevel: 'medium',
    enhancements: { mode: 'redirect', applyMode: 'as-swipe' }
  });
  const setup = await blockedMediumRedirect.runtime.prepareForGeneration({
    userMessage: 'Carter wants to test the transport method now.',
    hostGeneration: true
  });
  assertEqual(setup.ok, true, `Medium Redirect ${reasonerCapability} preflight preserves host generation`);
  const preflightWarning = blockedMediumRedirect.state.activityEvents.find((event) => (
    event.phase === 'editorialPreflight'
    && event.severity === 'warning'
  ));
  assertEqual(
    Boolean(preflightWarning),
    true,
    `Medium Redirect ${reasonerCapability} warns before assistant processing`
  );
  assertEqual(
    preflightWarning?.detail?.state,
    reasonerCapability,
    `Medium Redirect ${reasonerCapability} warning names the capability state`
  );
  assertEqual(
    blockedMediumRedirect.state.calls.some((call) => [
      'editorialDiagnostician',
      'editorialTransformer',
      'editorialVerifier'
    ].includes(call.roleId)),
    false,
    `Medium Redirect ${reasonerCapability} preflight makes no Editorial provider calls`
  );
  const blockedResult = await blockedMediumRedirect.runtime.enhanceLatestAssistantMessage({
    reason: 'assistant-message-landed'
  });
  assertEqual(blockedResult.ok, true, `Medium Redirect ${reasonerCapability} settles without a critical error`);
  assertEqual(blockedResult.skipped, true, `Medium Redirect ${reasonerCapability} settles skipped`);
  assertEqual(
    blockedMediumRedirect.runtime.view().editorialResult?.status,
    'skipped',
    `Medium Redirect ${reasonerCapability} records a skipped Editorial outcome`
  );
  assertEqual(
    blockedMediumRedirect.state.calls.some((call) => [
      'editorialDiagnostician',
      'editorialTransformer',
      'editorialVerifier'
    ].includes(call.roleId)),
    false,
    `Medium Redirect ${reasonerCapability} makes no diagnosis, transform, or verifier call`
  );
  assertEqual(blockedMediumRedirect.state.appended.length, 0, `Medium Redirect ${reasonerCapability} adds no swipe`);
  assertEqual(
    blockedMediumRedirect.state.message.text,
    redirectSource,
    `Medium Redirect ${reasonerCapability} preserves the original assistant response`
  );
}

for (const reasoningLevel of ['high', 'ultra']) {
  const reasonerWriterRedirect = createRedirectHarness({ reasonerCapability: 'ready' });
  await reasonerWriterRedirect.runtime.updateSettings({ reasoningLevel, enhancements: { mode: 'redirect', applyMode: 'as-swipe' } });
  const reasonerWriterResult = await reasonerWriterRedirect.runtime.enhanceLatestAssistantMessage({ reason: `redirect-${reasoningLevel}-reasoner-writer-test` });
  assertEqual(reasonerWriterResult.ok, true, `${reasoningLevel} Redirect succeeds with a Reasoner writer`);
  assertEqual(
    reasonerWriterRedirect.state.calls.find((call) => call.roleId === 'editorialTransformer')?.request?.lane,
    'reasoner',
    `${reasoningLevel} Redirect final writing uses Reasoner`
  );
}

const exhaustedReasonerWriter = createRedirectHarness({
  reasonerCapability: 'ready',
  transformProviderFailures: 2
});
await exhaustedReasonerWriter.runtime.updateSettings({ reasoningLevel: 'medium', enhancements: { mode: 'redirect', applyMode: 'as-swipe' } });
const exhaustedReasonerWriterResult = await exhaustedReasonerWriter.runtime.enhanceLatestAssistantMessage({ reason: 'redirect-reasoner-writer-exhausted-test' });
assertEqual(exhaustedReasonerWriterResult.ok, false, 'Medium Redirect fails after two Reasoner writer failures');
const exhaustedWriterCalls = exhaustedReasonerWriter.state.calls.filter((call) => call.roleId === 'editorialTransformer');
assertEqual(exhaustedWriterCalls.length, 2, 'Medium Redirect makes exactly two writer calls');
assertDeepEqual(exhaustedWriterCalls.map((call) => call.request.lane), ['reasoner', 'reasoner'], 'both Redirect writer attempts stay on Reasoner');
assert(exhaustedWriterCalls[1].request.prompt.includes('Editorial pass correction required'), 'second Reasoner writer receives correction instructions');
assert(exhaustedWriterCalls[1].request.prompt.includes('RECURSION_PROVIDER_TIMEOUT'), 'second Reasoner writer receives the first provider failure');
assert(exhaustedWriterCalls.every((call) => call.options.maxAttempts === 1), 'each Redirect writer wrapper call permits one actual model attempt');
assertEqual(exhaustedReasonerWriter.state.calls.some((call) => call.roleId === 'editorialVerifier'), false, 'failed Redirect writer never calls verifier');
assertEqual(exhaustedReasonerWriter.state.appended.length, 0, 'failed Redirect writer adds no swipe');
assertEqual(exhaustedReasonerWriter.state.message.text, redirectSource, 'failed Redirect writer preserves the original response');

const correctedNoChangeRedirect = createRedirectHarness({
  diagnosisOverride: (value, attempt) => attempt === 1 ? { ...value, decision: 'no-change' } : value
});
await correctedNoChangeRedirect.runtime.updateSettings({ reasoningLevel: 'medium', enhancements: { mode: 'redirect', applyMode: 'as-swipe' } });
const correctedNoChangeResult = await correctedNoChangeRedirect.runtime.enhanceLatestAssistantMessage({ reason: 'redirect-no-change-correction-test' });
assertEqual(correctedNoChangeResult.ok, true, 'Redirect canonicalizes a provider-authored no-change decision when the brief is complete');
assertEqual(correctedNoChangeRedirect.state.diagnosisAttempts, 1, 'Redirect does not spend a correction on a noisy decision token');
assertEqual(correctedNoChangeRedirect.state.appended.length, 1, 'canonicalized Redirect appends exactly one verified swipe');

const referenceRecoveryRedirect = createRedirectHarness({
  diagnosisOverride: (value) => ({
    ...value,
    requiredBeats: [{
      ...value.requiredBeats[0],
      evidenceRefs: ['missing:beat']
    }]
  })
});
await referenceRecoveryRedirect.runtime.updateSettings({ reasoningLevel: 'medium', enhancements: { mode: 'redirect', applyMode: 'as-swipe' } });
const referenceRecoveryResult = await referenceRecoveryRedirect.runtime.enhanceLatestAssistantMessage({ reason: 'redirect-reference-recovery-test' });
assertEqual(referenceRecoveryResult.ok, true, 'Redirect reference bookkeeping reaches semantic verification');
assertEqual(referenceRecoveryRedirect.state.diagnosisAttempts, 1, 'unknown reference adds no diagnosis correction call');
assertEqual(referenceRecoveryRedirect.state.transformAttempts, 1, 'unknown reference adds no writer call');
assertEqual(referenceRecoveryRedirect.state.verifierAttempts, 1, 'unknown reference reaches the mandatory verifier');
assertEqual(referenceRecoveryRedirect.state.appended.length, 1, 'verifier-accepted reference recovery appends one swipe');
assert(
  referenceRecoveryRedirect.state.calls.find((call) => call.roleId === 'editorialTransformer')?.request?.prompt
    .includes('requiredBeats[0].evidenceRefs[0]'),
  'Redirect writer receives the unresolved reference path'
);
assert(
  referenceRecoveryRedirect.state.calls.find((call) => call.roleId === 'editorialVerifier')?.request?.prompt
    .includes('requiredBeats[0].evidenceRefs[0]'),
  'Redirect verifier receives the unresolved reference path'
);

const pressureRecoveryRedirect = createRedirectHarness({
  diagnosisOverride: (value) => ({
    ...value,
    characterPressure: value.characterPressure.map((row) => ({
      ...row,
      sourcePressureEffect: '',
      sourceEvidenceRefs: [],
      pressureReason: ''
    }))
  })
});
await pressureRecoveryRedirect.runtime.updateSettings({ reasoningLevel: 'medium', enhancements: { mode: 'redirect', applyMode: 'as-swipe' } });
const pressureRecoveryResult = await pressureRecoveryRedirect.runtime.enhanceLatestAssistantMessage({ reason: 'redirect-pressure-recovery-test' });
assertEqual(pressureRecoveryResult.ok, true, 'blank advisory pressure bookkeeping reaches semantic verification');
assertEqual(pressureRecoveryRedirect.state.diagnosisAttempts, 1, 'blank advisory pressure adds no diagnosis correction call');
assertEqual(pressureRecoveryRedirect.state.transformAttempts, 1, 'blank advisory pressure adds no writer call');
assertEqual(pressureRecoveryRedirect.state.verifierAttempts, 1, 'blank advisory pressure reaches the mandatory verifier');
assertEqual(pressureRecoveryRedirect.state.appended.length, 1, 'verifier-accepted pressure recovery appends one swipe');
assert(
  pressureRecoveryRedirect.state.calls.find((call) => call.roleId === 'editorialTransformer')?.request?.prompt
    .includes('characterPressure[0].sourcePressureEffect'),
  'Redirect writer receives the normalized pressure path'
);
assert(
  pressureRecoveryRedirect.state.calls.find((call) => call.roleId === 'editorialVerifier')?.request?.prompt
    .includes('characterPressure[0].sourcePressureEffect'),
  'Redirect verifier receives the normalized pressure path'
);

const reasonerCorrectedRedirect = createRedirectHarness({
  reasonerCapability: 'ready',
  diagnosisProviderFailureOnFirst: true
});
await reasonerCorrectedRedirect.runtime.updateSettings({ reasoningLevel: 'medium', enhancements: { mode: 'redirect', applyMode: 'as-swipe' } });
const reasonerCorrectedResult = await reasonerCorrectedRedirect.runtime.enhanceLatestAssistantMessage({ reason: 'redirect-reasoner-correction-test' });
assertEqual(reasonerCorrectedResult.ok, true, 'Redirect escalates a structurally invalid Utility diagnosis correction to the healthy Reasoner lane');
assertDeepEqual(
  reasonerCorrectedRedirect.state.calls.filter((call) => call.roleId === 'editorialDiagnostician').map((call) => call.request.lane),
  ['utility', 'reasoner'],
  'Redirect diagnosis uses Utility first and Reasoner for its single runtime-owned correction'
);
assertEqual(
  reasonerCorrectedRedirect.state.calls.filter((call) => call.roleId === 'editorialDiagnostician')[0].options.allowStructuredRecovery,
  false,
  'Redirect prevents the provider layer from consuming its correction on the original Utility lane'
);
assert(reasonerCorrectedRedirect.state.calls.filter((call) => call.roleId === 'editorialDiagnostician')[1].request.prompt.includes('Editorial diagnosis correction required'), 'Reasoner correction receives the semantic validation failure');
assertEqual(reasonerCorrectedRedirect.state.appended.length, 1, 'Reasoner-corrected Redirect appends one verified swipe');

const utilityCorrectedRedirect = createRedirectHarness({
  reasonerCapability: 'untested',
  diagnosisOverride: (value, attempt) => attempt === 1
    ? {
        schema: value.schema,
        mode: value.mode,
        sourceHash: value.sourceHash,
        snapshotHash: value.snapshotHash,
        decision: value.decision,
        brief: {
          mode: 'The source postpones the requested test.',
          diagnosis: [{}, {}],
          preserve: [{}],
          discard: [{}],
          allowedChanges: ['message:47'],
          forbiddenChanges: ['source:0'],
          sourceFailure: 'Engage the proposed test now.',
          replacementObjective: { Carter: 'Test the transport method now.' },
          requiredBeats: [],
          forbiddenSourceBeats: [],
          sceneCharacters: [],
          characterPressure: []
        }
      }
    : value
});
await utilityCorrectedRedirect.runtime.updateSettings({ reasoningLevel: 'low', enhancements: { mode: 'redirect', applyMode: 'as-swipe' } });
const utilityCorrectedResult = await utilityCorrectedRedirect.runtime.enhanceLatestAssistantMessage({ reason: 'redirect-utility-correction-test' });
assertEqual(utilityCorrectedResult.ok, true, 'Low Redirect recovers from a semantically empty diagnosis on Utility');
const utilityDiagnosisCalls = utilityCorrectedRedirect.state.calls.filter((call) => call.roleId === 'editorialDiagnostician');
assertDeepEqual(
  utilityDiagnosisCalls.map((call) => call.request.lane),
  ['utility', 'utility'],
  'Low Redirect keeps its single semantic correction on Utility'
);
assert(
  utilityDiagnosisCalls[1].request.prompt.includes(REDIRECT_ERROR_CODES.LAYOUT_INVALID),
  'Utility-only Redirect correction receives the precise flat-layout error'
);
assertEqual(utilityCorrectedRedirect.state.appended.length, 1, 'Utility-corrected Redirect appends one verified swipe');

const repeatedNoChangeRedirect = createRedirectHarness({
  diagnosisOverride: (value) => ({
    ...value,
    decision: 'no-change',
    sourceFailure: null,
    replacementObjective: null,
    requiredBeats: [],
    forbiddenSourceBeats: []
  })
});
await repeatedNoChangeRedirect.runtime.updateSettings({ reasoningLevel: 'medium', enhancements: { mode: 'redirect', applyMode: 'as-swipe' } });
const repeatedNoChangeResult = await repeatedNoChangeRedirect.runtime.enhanceLatestAssistantMessage({ reason: 'redirect-no-change-failure-test' });
assertEqual(repeatedNoChangeResult.ok, false, 'Redirect fails when the provider repeatedly returns an empty no-change brief');
assertEqual(repeatedNoChangeResult.error?.code, REDIRECT_ERROR_CODES.BRIEF_INVALID, 'empty Redirect no-change preserves the brief error code');
assertEqual(repeatedNoChangeRedirect.runtime.view().editorialResult?.status, 'error', 'empty Redirect no-change settles visibly unhealthy');
assertEqual(repeatedNoChangeRedirect.state.diagnosisAttempts, 2, 'Redirect never makes a third diagnosis attempt');
assertEqual(repeatedNoChangeRedirect.state.appended.length, 0, 'invalid Redirect diagnosis never mutates host swipe state');
assertEqual(Boolean(repeatedNoChangeResult.skipped), false, 'invalid Redirect diagnosis never reports skipped success');

acceptedRedirect.state.reusePersisted = true;
acceptedRedirect.state.calls.length = 0;
const cachedRedirectResult = await acceptedRedirect.runtime.enhanceLatestAssistantMessage({ reason: 'redirect-cache-test' });
assertEqual(cachedRedirectResult.cached, true, 'verified Redirect reuses its cached swipe');
assertEqual(acceptedRedirect.state.calls.length, 0, 'verified Redirect cache reuse makes no provider calls');
assertDeepEqual(cachedRedirectResult.marker, acceptedRedirect.state.persistedMarker, 'cached Redirect returns the persisted accepted marker');
assertDeepEqual(acceptedRedirect.state.selected.at(-1).options.marker, acceptedRedirect.state.persistedMarker, 'cached Redirect selects with the persisted accepted marker');
assert(acceptedRedirect.state.persistedMarker.key.endsWith('::verify'), 'Redirect cache identity always records mandatory verification');

const partialCachedRedirect = createRedirectHarness({
  cachedMarkerFactory: (marker) => ({
    ...marker,
    outcome: 'partial-failed',
    verification: 'accept',
    candidateHash: 'partial-candidate',
    unresolvedCardIds: ['custom-card']
  })
});
await partialCachedRedirect.runtime.updateSettings({ reasoningLevel: 'medium', enhancements: { mode: 'redirect', applyMode: 'as-swipe' } });
const partialCachedRedirectResult = await partialCachedRedirect.runtime.enhanceLatestAssistantMessage({ reason: 'redirect-partial-cache-test' });
assertEqual(partialCachedRedirectResult.cached, undefined, 'partial-failed Editorial swipe is never reused as a healthy cached result');
assert(partialCachedRedirect.state.calls.length > 0, 'partial-failed cache entry falls through to a fresh Editorial run');

const directCachedRedirect = createRedirectHarness({
  cachedMarkerFactory: (marker) => ({ ...marker, verification: 'not-required', candidateHash: 'direct-candidate' })
});
await directCachedRedirect.runtime.updateSettings({ reasoningLevel: 'medium', enhancements: { mode: 'redirect', applyMode: 'as-swipe' } });
const directCachedResult = await directCachedRedirect.runtime.enhanceLatestAssistantMessage({ reason: 'redirect-direct-cache-test' });
assertEqual(directCachedResult.cached, undefined, 'Redirect does not reuse an unverified direct marker');
assertEqual(directCachedRedirect.state.calls.filter((call) => call.roleId === 'editorialVerifier').length, 1, 'unverified cache falls through to a fresh verified run');

const rejectedRedirect = createRedirectHarness({ verifierDecision: 'reject' });
await rejectedRedirect.runtime.updateSettings({ reasoningLevel: 'medium', enhancements: { mode: 'redirect', applyMode: 'as-swipe' } });
const rejectedRedirectResult = await rejectedRedirect.runtime.enhanceLatestAssistantMessage({ reason: 'redirect-rejected-test' });
assertEqual(rejectedRedirectResult.ok, false, 'verifier rejection keeps the original');
assertEqual(rejectedRedirectResult.error?.code, REDIRECT_ERROR_CODES.VERIFICATION_REJECTED, 'verifier rejection has a stable error code');
assertEqual(rejectedRedirect.state.appended.length, 0, 'verifier rejection adds no swipe');
assertEqual(rejectedRedirect.runtime.view().editorialResult?.status, 'error', 'verifier rejection settles visibly unhealthy');
assertEqual(
  rejectedRedirect.runtime.view().activity?.detail?.failure?.message,
  'Editorial verifier rejected candidate.',
  'terminal Redirect activity explains the verifier rejection'
);
assertEqual(rejectedRedirect.state.calls.length, 5, 'semantic verifier rejection uses one bounded writer and verifier retry');
assertEqual(rejectedRedirect.state.transformAttempts, 2, 'semantic rejection launches exactly one corrected writer');
assertEqual(rejectedRedirect.state.verifierAttempts, 2, 'semantic rejection verifies the corrected candidate');

const correctedCandidateRedirect = createRedirectHarness({
  verifierDecisions: ['reject', 'accept'],
  candidateOverride: (value, attempt) => attempt === 1
    ? value
    : {
        ...value,
        candidate: {
          ...value.candidate,
          text: 'Carter set the scanner beside the pattern. "Then we test it now," she said.',
          changeLedger: [{ kind: 'redirect', summary: 'Removed the deferral and began the test now.', evidenceRefs: ['message:47'] }]
        }
      }
});
await correctedCandidateRedirect.runtime.updateSettings({ reasoningLevel: 'medium', enhancements: { mode: 'redirect', applyMode: 'as-swipe' } });
const correctedCandidateResult = await correctedCandidateRedirect.runtime.enhanceLatestAssistantMessage({ reason: 'redirect-candidate-correction-test' });
assertEqual(correctedCandidateResult.ok, true, 'Redirect applies a corrected candidate after verifier acceptance');
assertEqual(correctedCandidateRedirect.state.transformAttempts, 2, 'Redirect makes exactly one semantic candidate revision');
assertEqual(correctedCandidateRedirect.state.verifierAttempts, 2, 'Redirect verifies the replacement candidate');
assertEqual(correctedCandidateRedirect.state.appended.length, 1, 'accepted semantic correction creates one swipe');
const correctedCandidateWriterCalls = correctedCandidateRedirect.state.calls.filter((call) => call.roleId === 'editorialTransformer');
assertDeepEqual(
  correctedCandidateWriterCalls.map((call) => call.request.lane),
  ['reasoner', 'reasoner'],
  'both Medium Redirect semantic writer attempts stay on Reasoner'
);
assert(
  correctedCandidateWriterCalls[1].request.prompt.includes('Editorial verifier rejected candidate'),
  'second writer receives the verifier rejection reason'
);

const correctedMalformedVerifierRedirect = createRedirectHarness({
  verifierChecksByAttempt: [
    [],
    REDIRECT_VERIFICATION_CHECKS.map((check) => ({
      check,
      status: 'pass',
      evidenceRefs: ['message:47'],
      note: 'Bound to frozen evidence.'
    }))
  ]
});
await correctedMalformedVerifierRedirect.runtime.updateSettings({ reasoningLevel: 'medium', enhancements: { mode: 'redirect', applyMode: 'as-swipe' } });
const correctedMalformedVerifierResult = await correctedMalformedVerifierRedirect.runtime.enhanceLatestAssistantMessage({ reason: 'redirect-malformed-verifier-correction-test' });
assertEqual(correctedMalformedVerifierResult.ok, true, 'Redirect retries one malformed verifier response without rewriting a valid candidate');
assertEqual(correctedMalformedVerifierRedirect.state.verifierAttempts, 2, 'malformed Redirect verifier receives exactly one correction');
assertEqual(correctedMalformedVerifierRedirect.state.transformAttempts, 1, 'verifier format correction does not regenerate the candidate');
const correctedMalformedVerifierCalls = correctedMalformedVerifierRedirect.state.calls.filter((call) => call.roleId === 'editorialVerifier');
assert(
  correctedMalformedVerifierCalls[1].request.prompt.includes(REDIRECT_ERROR_CODES.VERIFICATION_CHECKS_INVALID),
  'verifier correction receives the precise check validation error'
);
assertEqual(correctedMalformedVerifierRedirect.state.appended.length, 1, 'corrected verifier result permits one validated swipe');

const malformedRedirect = createRedirectHarness({ verifierChecks: [] });
await malformedRedirect.runtime.updateSettings({ reasoningLevel: 'medium', enhancements: { mode: 'redirect', applyMode: 'as-swipe' } });
const malformedRedirectResult = await malformedRedirect.runtime.enhanceLatestAssistantMessage({ reason: 'redirect-malformed-verifier-test' });
assertEqual(malformedRedirectResult.error?.code, REDIRECT_ERROR_CODES.VERIFICATION_CHECKS_INVALID, 'malformed verifier result preserves its stable error code');
assertEqual(malformedRedirect.state.verifierAttempts, 2, 'repeated malformed verifier output stops after one correction');
assertEqual(malformedRedirect.state.appended.length, 0, 'malformed verifier result adds no swipe');

const exhaustedRecoveryRedirect = createRedirectHarness({
  diagnosisProviderFailureOnFirst: true,
  verifierChecks: []
});
await exhaustedRecoveryRedirect.runtime.updateSettings({ reasoningLevel: 'medium', enhancements: { mode: 'redirect', applyMode: 'as-swipe' } });
const exhaustedRecoveryResult = await exhaustedRecoveryRedirect.runtime.enhanceLatestAssistantMessage({ reason: 'redirect-shared-recovery-budget-test' });
assertEqual(exhaustedRecoveryResult.ok, false, 'Redirect keeps the original when malformed verification follows diagnosis recovery');
assertEqual(exhaustedRecoveryRedirect.state.calls.length, 4, 'Redirect permits at most one additional model call across the complete operation');
assertEqual(exhaustedRecoveryRedirect.state.diagnosisAttempts, 2, 'diagnosis consumes the one operation recovery call');
assertEqual(exhaustedRecoveryRedirect.state.verifierAttempts, 1, 'verifier cannot claim a second recovery call after diagnosis correction');
assertEqual(exhaustedRecoveryRedirect.state.appended.length, 0, 'exhausted recovery budget never mutates swipe state');

const staleRedirect = createRedirectHarness({ changeSourceAfterVerifier: true });
await staleRedirect.runtime.updateSettings({ reasoningLevel: 'medium', enhancements: { mode: 'redirect', applyMode: 'as-swipe' } });
const staleRedirectResult = await staleRedirect.runtime.enhanceLatestAssistantMessage({ reason: 'redirect-source-race-test' });
assertEqual(staleRedirectResult.error?.code, 'RECURSION_EDITORIAL_SOURCE_CHANGED', 'Redirect rejects a source change after verification');
assertEqual(staleRedirect.state.appended.length, 0, 'source race adds no Redirect swipe');

const appendFailedRedirect = createRedirectHarness({ appendFailure: true });
await appendFailedRedirect.runtime.updateSettings({ reasoningLevel: 'medium', enhancements: { mode: 'redirect', applyMode: 'as-swipe' } });
const appendFailedRedirectResult = await appendFailedRedirect.runtime.enhanceLatestAssistantMessage({ reason: 'redirect-append-failure-test' });
assertEqual(appendFailedRedirectResult.error?.code, 'RECURSION_TEST_APPEND_FAILED', 'Redirect reports host append failure');
assertEqual(appendFailedRedirect.runtime.view().editorialResult?.status, 'error', 'append failure settles visibly unhealthy');

const invalidBriefRedirect = createRedirectHarness({
  diagnosisOverride: (value) => ({ ...value, replacementObjective: null })
});
await invalidBriefRedirect.runtime.updateSettings({ reasoningLevel: 'medium', enhancements: { mode: 'redirect', applyMode: 'as-swipe' } });
const invalidBriefResult = await invalidBriefRedirect.runtime.enhanceLatestAssistantMessage({ reason: 'redirect-invalid-brief-test' });
assertEqual(invalidBriefResult.error?.code, REDIRECT_ERROR_CODES.BRIEF_INVALID, 'runtime preserves Redirect diagnosis error code');
assertEqual(invalidBriefRedirect.state.appended.length, 0, 'invalid Redirect diagnosis adds no swipe');

const missingDirectionRedirect = createRedirectHarness({
  candidateOverride: (value) => ({
    ...value,
    candidate: { ...value.candidate, changeLedger: [{ kind: 'rewrite', summary: 'Minor rewrite.', evidenceRefs: ['source:0'] }] }
  })
});
await missingDirectionRedirect.runtime.updateSettings({ reasoningLevel: 'medium', enhancements: { mode: 'redirect', applyMode: 'as-swipe' } });
const missingDirectionResult = await missingDirectionRedirect.runtime.enhanceLatestAssistantMessage({ reason: 'redirect-missing-direction-test' });
assertEqual(missingDirectionResult.error?.code, REDIRECT_ERROR_CODES.CHANGE_MISSING, 'runtime preserves missing Redirect trajectory error code');
assertEqual(missingDirectionRedirect.state.appended.length, 0, 'missing Redirect trajectory adds no swipe');

const effectivenessCalls = [];
const effectivenessSettings = createLegacyEnhancementSettingsStore();
effectivenessSettings.updateProviderConfig('reasoner', { source: 'host-current-model' });
const effectivenessReasoner = effectivenessSettings.get().providers.reasoner;
effectivenessSettings.recordProviderHealth('reasoner', {
  status: 'pass',
  checkedAt: new Date().toISOString()
}, {
  configHash: providerConfigHash(effectivenessReasoner),
  configRevision: effectivenessReasoner.configRevision
});
const effectivenessRuntime = createRecursionRuntime({
  host: {},
  settingsStore: effectivenessSettings,
  storage: createStorageRepository({ storage: createMemoryStorageAdapter() }),
  activity: createActivityReporter(),
  generationRouter: {
    async generate(roleId, request) {
      effectivenessCalls.push({ roleId, request });
      return {
        ok: true,
        data: {
          schema: 'recursion.redirectEffectivenessJudge.v1',
          scenarioId: request.scenarioId,
          sourceHash: request.sourceHash,
          candidateHash: request.candidateHash,
          decision: 'pass',
          criteria: ['replacement-objective', 'forbidden-source-beats', 'character-pressure', 'evidence-and-constraints'].map((criterion) => ({
            criterion,
            status: 'pass',
            reason: 'Independent criterion passed.'
          }))
        },
        diagnostics: { providerId: 'judge-provider', model: 'judge-model' }
      };
    }
  }
});
assertEqual(typeof effectivenessRuntime.evaluateRedirectEffectiveness, 'function', 'runtime exposes narrow Redirect effectiveness method');
const effectivenessResult = await effectivenessRuntime.evaluateRedirectEffectiveness({
  scenarioId: 'redirect-turn-deferral',
  oracle: {
    expectedDecision: 'proceed',
    replacementObjective: 'Begin the test now.',
    requiredBeats: ['Carter engages the test.'],
    forbiddenSourceBeats: ['Postpone the test.'],
    pressureExpectations: [{ character: 'Carter', effect: 'increasing', responseRequired: false }]
  },
  sourceText: redirectSource,
  candidateText: redirectCandidateText,
  marker: acceptedRedirectResult.marker
});
assertEqual(effectivenessCalls.length, 1, 'runtime makes exactly one independent judge call');
assertEqual(effectivenessCalls[0].roleId, 'editorialEffectivenessJudge', 'runtime routes independent judge through its internal role');
assertEqual(effectivenessCalls[0].request.lane, 'reasoner', 'runtime routes effectiveness judge through a healthy Reasoner');
assertEqual(effectivenessResult.ok, true, 'runtime validates independent judge result');
assertEqual(effectivenessResult.diagnostics.providerId, 'judge-provider', 'runtime returns judge provider diagnostics');
assertEqual(effectivenessResult.diagnostics.model, 'judge-model', 'runtime returns judge model diagnostics');
console.log('[pass] editorial runtime');
