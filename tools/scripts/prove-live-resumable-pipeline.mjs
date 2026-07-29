import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import {
  createRunId,
  createSillyTavernHttpSession,
  validateSoakUserHandle
} from './lib/sillytavern-live-harness.mjs';

const DEFAULT_TIMEOUT_MS = 120000;

function fail(result, message, details = {}) {
  const error = new Error(message);
  error.result = result;
  error.details = details;
  throw error;
}

function passwordEnvKey(user) {
  return `RECURSION_SILLYTAVERN_PASSWORD_${String(user).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function passwordForUser(user, env) {
  return env[passwordEnvKey(user)] ?? env.RECURSION_SILLYTAVERN_PASSWORD ?? '';
}

function assertPreflight(argv, env) {
  if (!argv.includes('--live')) {
    fail('dry-run', 'Pass --live to mutate a dedicated SillyTavern user.');
  }
  if (!env.SILLYTAVERN_BASE_URL) {
    fail('missing-base-url', 'SILLYTAVERN_BASE_URL is required.');
  }
  const user = validateSoakUserHandle(env.RECURSION_SILLYTAVERN_USER);
  if (!user.ok) {
    fail(
      'unsafe-user',
      'RECURSION_SILLYTAVERN_USER must be a dedicated recursion-soak-* user.',
      user
    );
  }
  return user.user;
}

async function waitForRuntime(page, timeoutMs) {
  await page.waitForSelector('#recursion-root', { timeout: timeoutMs });
  await page.waitForFunction(
    () => Boolean(globalThis.__recursionLiveHarnessRuntime?.view),
    null,
    { timeout: timeoutMs }
  );
}

async function installProviderFixture(page) {
  await page.evaluate(() => {
    const context = globalThis.SillyTavern?.getContext?.()
      || globalThis.getContext?.()
      || {};
    const fixture = {
      calls: [],
      scenario: 'segmented-pause',
      gateRole: 'activeCastCard',
      gateOpened: false,
      promptFailure: false,
      originalGetContext: typeof globalThis.SillyTavern?.getContext === 'function'
        ? globalThis.SillyTavern.getContext.bind(globalThis.SillyTavern)
        : null,
      originalGlobalGetContext: typeof globalThis.getContext === 'function'
        ? globalThis.getContext.bind(globalThis)
        : null,
      originalGenerateRaw: typeof context.generateRaw === 'function'
        ? context.generateRaw.bind(context)
        : null,
      originalSetExtensionPrompt: typeof context.setExtensionPrompt === 'function'
        ? context.setExtensionPrompt.bind(context)
        : null
    };
    const schemaRoot = (request) => (
      request?.jsonSchema?.schema
      || request?.jsonSchema?.value
      || request?.jsonSchema
      || {}
    );
    const schemaValue = (request) => String(
      schemaRoot(request)?.properties?.schema?.const
      || request?.jsonSchema?.name
      || ''
    );
    const snapshotHash = (request) => String(
      schemaRoot(request)?.properties?.snapshotHash?.const
      || ''
    );
    const roleFor = (request) => {
      const schema = schemaValue(request);
      const prompt = String(request?.prompt || '').toLowerCase();
      if (schema.includes('utilityArbiter')) return 'utilityArbiter';
      if (schema.includes('cardBundle')) return 'fusedCardBundle';
      if (schema.includes('guidanceComposer')) return 'guidanceComposer';
      if (schema.includes('postProcessGuidance')) return 'postProcessGuidanceUtility';
      if (schema.includes('card')) {
        return prompt.includes('active cast') ? 'activeCastCard' : 'sceneFrameCard';
      }
      return schema || 'unknown';
    };
    const arbiterPayload = (request) => ({
      schema: 'recursion.utilityArbiter.v1',
      snapshotHash: snapshotHash(request),
      action: 'compose-brief',
      sceneStatus: 'same-scene',
      promptFootprint: 'normal',
      cardJobs: [
        {
          family: 'Scene Frame',
          role: 'sceneFrameCard',
          reason: 'Preserve the current fixture beat.'
        },
        {
          family: 'Active Cast',
          role: 'activeCastCard',
          reason: 'Preserve fixture participants.'
        }
      ],
      budgets: { targetBriefTokens: 500, maxCards: 4 },
      reasonerDecision: {
        mode: 'skip',
        reason: 'Deterministic live verification fixture.',
        signals: []
      },
      diagnostics: []
    });
    const cardPayload = (request, role) => {
      const family = role === 'activeCastCard' ? 'Active Cast' : 'Scene Frame';
      return {
        schema: 'recursion.card.v1',
        family,
        role,
        snapshotHash: snapshotHash(request),
        items: [{
          promptText: `Fixture ${family} instruction.`,
          evidenceRefs: ['message:1'],
          tokenEstimate: 8
        }]
      };
    };
    const guidancePayload = (request) => ({
      schema: 'recursion.guidanceComposer.v1',
      snapshotHash: snapshotHash(request),
      guidanceText: 'Fixture guidance.',
      sourceCardIds: [],
      guardrailCardIds: [],
      omittedCardIds: [],
      diagnostics: []
    });
    const bundlePayload = (request) => {
      const items = fixture.scenario === 'fused-zero'
        ? []
        : [{
            schema: 'recursion.card.v1',
            family: 'Scene Frame',
            role: 'sceneFrameCard',
            promptText: 'Fixture Scene Frame instruction.',
            evidenceRefs: ['message:1'],
            tokenEstimate: 8
          }];
      return {
        schema: 'recursion.cardBundle.v1',
        snapshotHash: snapshotHash(request),
        items
      };
    };
    const postProcessGuidancePayload = (request) => ({
      schema: 'recursion.postProcessGuidance.v1',
      snapshotHash: String(
        schemaRoot(request)?.properties?.snapshotHash?.const
        || ''
      ),
      sourceHash: String(
        schemaRoot(request)?.properties?.sourceHash?.const
        || ''
      ),
      guidanceText: 'Fixture post-process guidance.'
    });
    const abortError = () => {
      const error = new Error('Fixture request aborted.');
      error.name = 'AbortError';
      error.code = 'ABORT_ERR';
      return error;
    };

    fixture.fakeGenerateRaw = async (request = {}) => {
      const role = roleFor(request);
      fixture.calls.push({
        role,
        scenario: fixture.scenario,
        aborted: request.signal?.aborted === true
      });
      if (
        fixture.scenario === 'segmented-pause'
        && role === fixture.gateRole
        && fixture.gateOpened === false
      ) {
        fixture.gateOpened = true;
        return await new Promise((resolve, reject) => {
          fixture.pendingRequest = { role };
          if (request.signal?.aborted) {
            reject(abortError());
            return;
          }
          request.signal?.addEventListener?.('abort', () => reject(abortError()), {
            once: true
          });
        });
      }
      if (fixture.scenario === 'retry-failure' && role === 'guidanceComposer') {
        const error = new Error('Deterministic retry fixture failure.');
        error.code = 'RECURSION_FIXTURE_RETRYABLE';
        error.retryable = true;
        throw error;
      }
      let payload;
      if (role === 'utilityArbiter') payload = arbiterPayload(request);
      else if (role === 'fusedCardBundle') payload = bundlePayload(request);
      else if (role === 'sceneFrameCard' || role === 'activeCastCard') {
        payload = cardPayload(request, role);
      } else if (role === 'guidanceComposer') payload = guidancePayload(request);
      else if (role === 'postProcessGuidanceUtility') {
        payload = postProcessGuidancePayload(request);
      } else {
        throw new Error(`Unhandled fixture role: ${role}`);
      }
      return {
        text: JSON.stringify(payload),
        providerSource: 'live-fixture',
        model: 'deterministic-fixture'
      };
    };

    if (fixture.originalSetExtensionPrompt) {
      fixture.fakeSetExtensionPrompt = (...args) => {
        const value = String(args[1] || '');
        const isRecursionInstall = String(args[0] || '').startsWith('recursion.')
          && value.length > 0;
        if (fixture.promptFailure && isRecursionInstall) {
          throw new Error('Deterministic prompt-install fixture failure.');
        }
        return fixture.originalSetExtensionPrompt(...args);
      };
    }

    fixture.chat = [
      {
        mesid: 0,
        is_user: false,
        name: 'Recursion Fixture',
        mes: 'Fixture assistant source.',
        swipe_id: 0,
        swipes: ['Fixture assistant source.'],
        swipe_info: [{ extra: {} }]
      },
      {
        mesid: 1,
        is_user: true,
        name: 'Recursion Fixture',
        mes: 'Fixture user request.',
        swipe_id: 0,
        swipes: ['Fixture user request.'],
        swipe_info: [{ extra: {} }]
      }
    ];
    const applyFixtureContext = (nextContext = {}) => {
      nextContext.chat = fixture.chat;
      nextContext.generateRaw = fixture.fakeGenerateRaw;
      if (fixture.fakeSetExtensionPrompt) {
        nextContext.setExtensionPrompt = fixture.fakeSetExtensionPrompt;
      }
      return nextContext;
    };
    applyFixtureContext(context);
    if (fixture.originalGetContext) {
      globalThis.SillyTavern.getContext = () => (
        applyFixtureContext(fixture.originalGetContext())
      );
    }
    if (fixture.originalGlobalGetContext) {
      globalThis.getContext = () => (
        applyFixtureContext(fixture.originalGlobalGetContext())
      );
    }
    globalThis.__recursionResumableFixture = fixture;
  });
}

async function restoreProviderFixture(page) {
  await page.evaluate(() => {
    const context = globalThis.SillyTavern?.getContext?.()
      || globalThis.getContext?.()
      || {};
    const fixture = globalThis.__recursionResumableFixture;
    if (!fixture) return;
    if (fixture.originalGetContext) {
      globalThis.SillyTavern.getContext = fixture.originalGetContext;
    }
    if (fixture.originalGlobalGetContext) {
      globalThis.getContext = fixture.originalGlobalGetContext;
    }
    if (fixture.originalGenerateRaw) context.generateRaw = fixture.originalGenerateRaw;
    if (fixture.originalSetExtensionPrompt) {
      context.setExtensionPrompt = fixture.originalSetExtensionPrompt;
    }
    delete globalThis.__recursionResumableFixture;
  }).catch(() => {});
}

async function resetFixtureSource(page, marker) {
  await page.evaluate((nextMarker) => {
    const chat = globalThis.__recursionResumableFixture?.chat;
    if (!Array.isArray(chat) || chat.length < 2) {
      throw new Error('Fixture chat is unavailable.');
    }
    chat[0].mes = `Fixture assistant source ${nextMarker}.`;
    chat[0].swipes = [chat[0].mes];
    chat[1].mes = `Fixture user request ${nextMarker}.`;
    chat[1].swipes = [chat[1].mes];
  }, marker);
}

async function runtimeSummary(page) {
  return await page.evaluate(async () => {
    const runtime = globalThis.__recursionLiveHarnessRuntime;
    const view = runtime?.view?.() || {};
    const chatKey = String(view.execution?.chatKey || '');
    const manifest = chatKey
      ? await runtime.storage.loadPipelineRun(chatKey)
      : null;
    const queued = chatKey
      ? await runtime.storage.loadQueuedReprocess(chatKey)
      : null;
    const calls = globalThis.__recursionResumableFixture?.calls || [];
    return {
      execution: manifest
        ? {
            operationId: manifest.operationId,
            chatKey: manifest.chatKey,
            phase: manifest.phase,
            pipelineMode: manifest.pipelineMode,
            state: manifest.state,
            pauseReason: manifest.pauseReason,
            frontierStageIds: manifest.frontierStageIds,
            queuedStageIds: manifest.queuedStageIds,
            stageStates: Object.fromEntries(
              Object.entries(manifest.stageRecords || {})
                .map(([id, record]) => [id, {
                  state: record.state,
                  attemptsUsed: record.attempts?.used || 0,
                  attemptsTotal: record.attempts?.total || 0
                }])
            )
          }
        : null,
      queued: queued
        ? { mode: queued.mode, stageIds: queued.stageIds }
        : null,
      activity: {
        label: String(view.activity?.label || ''),
        outcome: String(view.activity?.outcome || '')
      },
      callCounts: Object.fromEntries(
        [...new Set(calls.map((entry) => entry.role))]
          .map((role) => [role, calls.filter((entry) => entry.role === role).length])
      ),
      calls: calls.map((entry) => ({
        role: entry.role,
        scenario: entry.scenario,
        aborted: entry.aborted
      }))
    };
  });
}

async function configureRuntime(page, patch) {
  return await page.evaluate(async (settingsPatch) => {
    const runtime = globalThis.__recursionLiveHarnessRuntime;
    if (!runtime?.updateSettings) throw new Error('Recursion runtime unavailable.');
    await runtime.updateProviderConfig('utility', {
      source: 'host-current-model',
      hostConnectionProfileId: ''
    });
    await runtime.updateProviderConfig('reasoner', {
      source: 'host-current-model',
      hostConnectionProfileId: ''
    });
    return await runtime.updateSettings(settingsPatch);
  }, patch);
}

function count(summary, role) {
  return Number(summary.callCounts?.[role] || 0);
}

function assertEqual(actual, expected, message, details = {}) {
  if (actual !== expected) {
    fail('assertion-failed', `${message} Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`, {
      ...details,
      actual,
      expected
    });
  }
}

function assert(value, message, details = {}) {
  if (!value) fail('assertion-failed', message, details);
}

async function proveSegmentedPauseReloadResume(page, timeoutMs) {
  console.error('[live-proof] segmented: configure');
  await configureRuntime(page, {
    enabled: true,
    mode: 'auto',
    pipelineMode: 'segmented',
    modelAttemptsPerStep: 2,
    reasoningLevel: 'low',
    reasonerUse: 'off',
    minCards: 2,
    maxCards: 2
  });
  await page.evaluate(async () => {
    await globalThis.__recursionLiveHarnessRuntime.resetSceneCache();
    const fixture = globalThis.__recursionResumableFixture;
    fixture.scenario = 'segmented-pause';
    fixture.gateOpened = false;
    fixture.pendingRequest = null;
    fixture.preparingSettled = false;
    fixture.preparing = globalThis.__recursionLiveHarnessRuntime
      .prepareForGeneration({
        userMessage: 'Fixture user request.',
        hostGeneration: true
      })
      .then((result) => {
        fixture.preparingResult = result;
        fixture.preparingSettled = true;
        return result;
      });
  });
  console.error('[live-proof] segmented: wait for pending child');
  try {
    await page.waitForFunction(() => {
      const fixture = globalThis.__recursionResumableFixture;
      const execution = globalThis.__recursionLiveHarnessRuntime?.view?.()?.execution;
      return fixture?.pendingRequest?.role === 'activeCastCard'
        && execution?.stageRecords?.['preprocess.cards.segmented.scene-frame']?.state === 'completed';
    }, null, { timeout: timeoutMs });
  } catch (error) {
    fail(
      'segmented-child-not-pending',
      'Segmented fixture did not reach one completed and one pending child.',
      await runtimeSummary(page)
    );
  }
  console.error('[live-proof] segmented: pause');
  await page.evaluate(async () => {
    await globalThis.__recursionLiveHarnessRuntime.pauseOperation({
      reason: 'user-stop'
    });
  });
  await page.waitForFunction(
    () => globalThis.__recursionResumableFixture?.preparingSettled === true,
    null,
    { timeout: timeoutMs }
  );
  const paused = await runtimeSummary(page);
  assertEqual(paused.execution?.state, 'paused', 'Stop must pause the operation.', paused);
  assertEqual(
    paused.execution?.stageStates?.['preprocess.arbiter']?.state,
    'completed',
    'Stop must retain the Arbiter checkpoint.',
    paused
  );
  assertEqual(
    paused.execution?.stageStates?.['preprocess.cards.segmented.scene-frame']?.state,
    'completed',
    'Stop must retain the completed sibling checkpoint.',
    paused
  );
  assertEqual(
    paused.execution?.stageStates?.['preprocess.cards.segmented.active-cast']?.state,
    'pending',
    'Stop must return the interrupted child to pending.',
    paused
  );
  assertEqual(
    paused.activity.label,
    'Operation paused. Completed work was saved.',
    'Stop must expose the approved confirmation.',
    paused
  );

  const operationId = paused.execution.operationId;
  const callsBeforeReload = paused.calls.length;
  console.error('[live-proof] segmented: reload extension');
  await page.evaluate(async () => {
    const fixture = globalThis.__recursionResumableFixture;
    fixture.oldRuntime = globalThis.__recursionLiveHarnessRuntime;
    fixture.scenario = 'segmented-resume';
    await globalThis.recursionOnDisable();
    await globalThis.recursionOnEnable();
  });
  await page.waitForFunction((previousOperationId) => {
    const fixture = globalThis.__recursionResumableFixture;
    const runtime = globalThis.__recursionLiveHarnessRuntime;
    const execution = runtime?.view?.()?.execution;
    return runtime
      && runtime !== fixture?.oldRuntime
      && execution?.operationId === previousOperationId
      && execution?.state === 'paused';
  }, operationId, { timeout: timeoutMs });
  await page.evaluate(async () => {
    await globalThis.__recursionLiveHarnessRuntime.restoreExecutionState();
  });
  const reloaded = await runtimeSummary(page);
  assertEqual(
    reloaded.calls.length,
    callsBeforeReload,
    'Reload must not execute a model call.',
    reloaded
  );

  console.error('[live-proof] segmented: resume');
  await page.evaluate(async (id) => {
    await globalThis.__recursionLiveHarnessRuntime.resumeOperation({
      operationId: id
    });
  }, operationId);
  const resumed = await runtimeSummary(page);
  assertEqual(resumed.execution?.state, 'completed', 'Resume must finish the operation.', resumed);
  assertEqual(count(resumed, 'utilityArbiter'), 1, 'Resume must reuse Arbiter.', resumed);
  assertEqual(count(resumed, 'sceneFrameCard'), 1, 'Resume must reuse completed sibling.', resumed);
  assertEqual(count(resumed, 'activeCastCard'), 2, 'Resume must rerun only interrupted child.', resumed);
  return { paused, reloaded, resumed };
}

async function proveRetryReprocessAndFresh(page) {
  console.error('[live-proof] recovery: queue and fail');
  const beforeQueue = await runtimeSummary(page);
  const operationId = beforeQueue.execution.operationId;
  const stageId = 'preprocess.guidance';
  await page.evaluate(async (id) => {
    await globalThis.__recursionLiveHarnessRuntime.queueStageReprocess({
      stageId: id
    });
  }, stageId);
  const queued = await runtimeSummary(page);
  assertEqual(
    queued.calls.length,
    beforeQueue.calls.length,
    'Queueing Reprocess must perform no model call.',
    queued
  );
  assert(
    queued.queued?.stageIds?.includes(stageId),
    'Queued Reprocess must persist the selected stage.',
    queued
  );

  await page.evaluate(async () => {
    globalThis.__recursionResumableFixture.scenario = 'retry-failure';
    await globalThis.__recursionLiveHarnessRuntime.prepareForGeneration({
      userMessage: 'Fixture user request.',
      hostGeneration: true
    });
  });
  const failed = await runtimeSummary(page);
  assertEqual(failed.execution.operationId, operationId, 'Reprocess must reuse the operation.', failed);
  assertEqual(failed.execution.state, 'paused', 'Exhausted guidance stage must pause.', failed);
  assertEqual(
    failed.execution.stageStates[stageId]?.state,
    'failed',
    'Exhausted reprocess stage must remain failed.',
    failed
  );
  assertEqual(failed.queued, null, 'Queued intent must be consumed when the stage starts.', failed);
  assertEqual(
    count(failed, 'guidanceComposer'),
    count(beforeQueue, 'guidanceComposer') + 2,
    'Failed stage must consume its two-attempt window.',
    failed
  );

  const callsBeforeRetry = { ...failed.callCounts };
  console.error('[live-proof] recovery: retry');
  await page.evaluate(async ({ id, stage }) => {
    globalThis.__recursionResumableFixture.scenario = 'retry-success';
    await globalThis.__recursionLiveHarnessRuntime.retryStage({
      operationId: id,
      stageId: stage
    });
  }, { id: operationId, stage: stageId });
  const retried = await runtimeSummary(page);
  assertEqual(retried.execution.state, 'completed', 'Retry must complete the failed operation.', retried);
  assertEqual(
    count(retried, 'utilityArbiter'),
    Number(callsBeforeRetry.utilityArbiter || 0),
    'Retry must not rerun Arbiter.',
    retried
  );
  assertEqual(
    count(retried, 'sceneFrameCard'),
    Number(callsBeforeRetry.sceneFrameCard || 0),
    'Retry must not rerun the successful sibling.',
    retried
  );
  assertEqual(
    count(retried, 'activeCastCard'),
    Number(callsBeforeRetry.activeCastCard || 0),
    'Retry must not rerun the other successful sibling.',
    retried
  );
  assertEqual(
    count(retried, 'guidanceComposer'),
    Number(callsBeforeRetry.guidanceComposer || 0) + 1,
    'Retry must open a fresh window for the failed stage.',
    retried
  );

  const cancelStage = 'preprocess.cards.segmented.scene-frame';
  console.error('[live-proof] recovery: queue and cancel');
  await page.evaluate(async (id) => {
    await globalThis.__recursionLiveHarnessRuntime.queueStageReprocess({
      stageId: id
    });
    await globalThis.__recursionLiveHarnessRuntime.cancelQueuedStageReprocess({
      stageId: id
    });
  }, cancelStage);
  const canceled = await runtimeSummary(page);
  assertEqual(canceled.queued, null, 'Cancel must remove queued reprocess.', canceled);
  assertEqual(
    canceled.activity.label,
    'Queued reprocessing canceled.',
    'Cancel must expose the approved confirmation.',
    canceled
  );

  const beforeFresh = await runtimeSummary(page);
  console.error('[live-proof] recovery: full fresh');
  await page.evaluate(async () => {
    await globalThis.__recursionLiveHarnessRuntime.requestFreshNextGeneration({
      source: 'live-fixture'
    });
  });
  const freshQueued = await runtimeSummary(page);
  assertEqual(
    freshQueued.calls.length,
    beforeFresh.calls.length,
    'Full fresh queue must perform no model call.',
    freshQueued
  );
  await page.evaluate(async () => {
    globalThis.__recursionResumableFixture.scenario = 'full-fresh';
    await globalThis.__recursionLiveHarnessRuntime.prepareForGeneration({
      userMessage: 'Fixture user request.',
      hostGeneration: true
    });
  });
  const fresh = await runtimeSummary(page);
  assertEqual(
    count(fresh, 'utilityArbiter'),
    count(beforeFresh, 'utilityArbiter') + 1,
    'Full fresh must rerun Arbiter once.',
    fresh
  );
  assertEqual(
    count(fresh, 'sceneFrameCard'),
    count(beforeFresh, 'sceneFrameCard') + 1,
    'Full fresh must rerun Scene Frame once.',
    fresh
  );
  assertEqual(
    count(fresh, 'activeCastCard'),
    count(beforeFresh, 'activeCastCard') + 1,
    'Full fresh must rerun Active Cast once.',
    fresh
  );
  assertEqual(fresh.queued, null, 'Full fresh must be one-shot.', fresh);
  return { queued, failed, retried, canceled, freshQueued, fresh };
}

async function proveFused(page, timeoutMs) {
  console.error('[live-proof] fused: partial');
  await page.evaluate(async () => {
    await globalThis.__recursionLiveHarnessRuntime.handleHostGenerationEnded?.();
    await globalThis.__recursionLiveHarnessRuntime.resetSceneCache();
  });
  await resetFixtureSource(page, 'fused-partial');
  await configureRuntime(page, {
    pipelineMode: 'fused',
    modelAttemptsPerStep: 2
  });
  await page.evaluate(async () => {
    globalThis.__recursionResumableFixture.scenario = 'fused-partial';
    await globalThis.__recursionLiveHarnessRuntime.prepareForGeneration({
      userMessage: 'Fixture user request fused-partial.',
      hostGeneration: true
    });
  });
  const partial = await runtimeSummary(page);
  assertEqual(partial.execution?.state, 'completed', 'Partial Fused output must complete.', partial);
  const partialCalls = partial.calls.filter((entry) => entry.scenario === 'fused-partial');
  assertEqual(
    partialCalls.filter((entry) => entry.role === 'utilityArbiter').length,
    1,
    'Partial Fused output must call Arbiter once.',
    partial
  );
  assertEqual(
    partialCalls.filter((entry) => entry.role === 'fusedCardBundle').length,
    1,
    'A useful Fused item must settle the bundle window.',
    partial
  );
  assertEqual(
    partial.execution.stageStates['preprocess.cards.fused']?.state,
    'completed',
    'Partial Fused output must checkpoint the bundle.',
    partial
  );

  console.error('[live-proof] fused: zero useful');
  await page.evaluate(async () => {
    await globalThis.__recursionLiveHarnessRuntime.resetSceneCache();
  });
  await resetFixtureSource(page, 'fused-zero');
  await page.evaluate(async () => {
    globalThis.__recursionResumableFixture.scenario = 'fused-zero';
    await globalThis.__recursionLiveHarnessRuntime.prepareForGeneration({
      userMessage: 'Fixture user request fused-zero.',
      hostGeneration: true
    });
  });
  try {
    await page.waitForFunction(
      () => globalThis.__recursionLiveHarnessRuntime?.view?.()?.execution?.state === 'completed',
      null,
      { timeout: timeoutMs }
    );
  } catch {
    fail(
      'fused-zero-not-completed',
      'Zero-useful Fused fixture did not reach completion.',
      await runtimeSummary(page)
    );
  }
  const zero = await runtimeSummary(page);
  const zeroCalls = zero.calls.filter((entry) => entry.scenario === 'fused-zero');
  assertEqual(zero.execution?.state, 'completed', 'Zero-useful Fused fallback must complete.', zero);
  assertEqual(
    zeroCalls.filter((entry) => entry.role === 'utilityArbiter').length,
    1,
    'Zero-useful fallback must reuse Arbiter.',
    zero
  );
  assertEqual(
    zeroCalls.filter((entry) => entry.role === 'fusedCardBundle').length,
    2,
    'Fused must consume its two-attempt window before fallback.',
    zero
  );
  assertEqual(
    zeroCalls.filter((entry) => entry.role === 'sceneFrameCard').length,
    1,
    'Fallback must run Scene Frame once.',
    zero
  );
  assertEqual(
    zeroCalls.filter((entry) => entry.role === 'activeCastCard').length,
    1,
    'Fallback must run Active Cast once.',
    zero
  );
  return { partial, zero };
}

async function provePromptInstallFailureAndReset(page) {
  console.error('[live-proof] prompt failure and reset');
  await page.evaluate(async () => {
    await globalThis.__recursionLiveHarnessRuntime.handleHostGenerationEnded?.();
    await globalThis.__recursionLiveHarnessRuntime.resetSceneCache();
  });
  await resetFixtureSource(page, 'prompt-failure');
  await configureRuntime(page, { pipelineMode: 'segmented' });
  const result = await page.evaluate(async () => {
    const fixture = globalThis.__recursionResumableFixture;
    fixture.scenario = 'prompt-failure';
    fixture.promptFailure = true;
    const prepared = await globalThis.__recursionLiveHarnessRuntime.prepareForGeneration({
      userMessage: 'Fixture user request prompt-failure.',
      hostGeneration: true
    });
    fixture.promptFailure = false;
    return {
      ok: prepared?.ok === true,
      continuePrimaryGeneration: prepared?.continuePrimaryGeneration === true,
      recursionPromptInstalled: prepared?.recursionPromptInstalled === true
    };
  });
  const failure = await runtimeSummary(page);
  assertEqual(result.ok, true, 'Prompt failure must settle fail-soft.', { result, failure });
  assertEqual(
    result.continuePrimaryGeneration,
    true,
    'Prompt failure must permit primary generation.',
    { result, failure }
  );
  assertEqual(
    result.recursionPromptInstalled,
    false,
    'Prompt failure must remain explicit.',
    { result, failure }
  );
  assertEqual(
    failure.execution?.stageStates?.['preprocess.install']?.state,
    'failed',
    'Prompt-install stage must remain visibly failed.',
    failure
  );

  await page.evaluate(async () => {
    await globalThis.__recursionLiveHarnessRuntime.queueStageReprocess({
      stageId: 'preprocess.arbiter'
    });
    await globalThis.__recursionLiveHarnessRuntime.resetSceneCache();
  });
  const reset = await runtimeSummary(page);
  assertEqual(reset.execution, null, 'Reset must clear execution manifest.', reset);
  assertEqual(reset.queued, null, 'Reset must clear queued intent.', reset);
  return { result, failure, reset };
}

async function inspectProgressUi(page) {
  console.error('[live-proof] UI: desktop and mobile');
  await page.evaluate(async () => {
    await globalThis.__recursionLiveHarnessRuntime.handleHostGenerationEnded?.();
    await globalThis.__recursionLiveHarnessRuntime.resetSceneCache();
  });
  await resetFixtureSource(page, 'ui');
  await configureRuntime(page, {
    pipelineMode: 'segmented',
    minCards: 2,
    maxCards: 2
  });
  await page.evaluate(async () => {
    const fixture = globalThis.__recursionResumableFixture;
    fixture.scenario = 'segmented-pause';
    fixture.gateOpened = false;
    fixture.pendingRequest = null;
    fixture.uiPreparingSettled = false;
    fixture.uiPreparing = globalThis.__recursionLiveHarnessRuntime.prepareForGeneration({
      userMessage: 'Fixture user request ui.',
      hostGeneration: true
    }).then((result) => {
      fixture.uiPreparingResult = result;
      fixture.uiPreparingSettled = true;
      return result;
    });
  });
  await page.waitForFunction(
    () => globalThis.__recursionResumableFixture?.pendingRequest?.role === 'activeCastCard',
    null,
    { timeout: DEFAULT_TIMEOUT_MS }
  );
  await page.evaluate(async () => {
    await globalThis.__recursionLiveHarnessRuntime.pauseOperation({
      reason: 'user-stop'
    });
  });
  await page.waitForFunction(
    () => globalThis.__recursionResumableFixture?.uiPreparingSettled === true,
    null,
    { timeout: DEFAULT_TIMEOUT_MS }
  );
  const toggle = page.locator('[data-recursion-status-trigger]').first();
  await toggle.click();
  await page.waitForFunction(
    () => document.querySelector('[data-recursion-status-popover]')?.hidden === false,
    null,
    { timeout: DEFAULT_TIMEOUT_MS }
  );
  const inspect = async (viewport) => {
    await page.setViewportSize(viewport);
    return await page.evaluate(() => {
      const panel = document.querySelector('[data-recursion-status-popover]');
      const rows = [...document.querySelectorAll('[data-recursion-progress-row]')];
      return {
        viewport: { width: innerWidth, height: innerHeight },
        panel: panel
          ? {
              clientWidth: panel.clientWidth,
              scrollWidth: panel.scrollWidth,
              overflow: panel.scrollWidth > panel.clientWidth
            }
          : null,
        rows: rows.slice(0, 40).map((row) => {
          const slot = row.querySelector('[data-recursion-progress-action-slot]');
          const buttons = row.querySelectorAll('[data-recursion-progress-action]');
          const button = buttons[0] || null;
          const slotRect = slot?.getBoundingClientRect?.();
          return {
            stageId: row.dataset.recursionProgressStepId || '',
            actionCount: buttons.length,
            slotWidth: slotRect ? Math.round(slotRect.width) : 0,
            slotHeight: slotRect ? Math.round(slotRect.height) : 0,
            ariaLabel: button?.getAttribute('aria-label') || '',
            title: button?.getAttribute('title') || ''
          };
        })
      };
    });
  };
  const desktop = await inspect({ width: 1360, height: 820 });
  const mobile = await inspect({ width: 390, height: 844 });
  for (const proof of [desktop, mobile]) {
    assertEqual(proof.panel?.overflow, false, 'Progress panel must not overflow horizontally.', proof);
    assert(
      proof.rows.length > 0,
      'Progress panel must render execution rows.',
      proof
    );
    for (const row of proof.rows) {
      assert(
        row.actionCount <= 1,
        'Each progress row must expose at most one action.',
        { proof, row }
      );
      if (row.actionCount === 1) {
        assertEqual(row.slotWidth, 24, 'Action slot width must be 24px.', { proof, row });
        assertEqual(row.slotHeight, 24, 'Action slot height must be 24px.', { proof, row });
        assert(Boolean(row.ariaLabel), 'Action must expose an accessible name.', { proof, row });
        assert(Boolean(row.title), 'Action must expose a tooltip.', { proof, row });
      }
    }
  }
  await page.setViewportSize({ width: 1360, height: 820 });
  return { desktop, mobile };
}

async function provePostProcessFixtures(page) {
  console.error('[live-proof] post-process: unified, progressive, idempotent commit');
  const proof = await page.evaluate(async () => {
    const [{ createPostProcessRuntime }, storageModule, schedulerModule] = await Promise.all([
      import('/scripts/extensions/third-party/Recursion/src/post-process-runtime.mjs'),
      import('/scripts/extensions/third-party/Recursion/src/storage.mjs'),
      import('/scripts/extensions/third-party/Recursion/src/execution/scheduler.mjs')
    ]);
    const {
      createMemoryStorageAdapter,
      createStorageRepository
    } = storageModule;
    const { createExecutionScheduler } = schedulerModule;
    const deferred = () => {
      let resolve;
      let reject;
      const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      return { promise, resolve, reject };
    };
    const waitUntil = async (predicate, message) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error(message);
    };
    const category = (id) => ({
      id,
      name: id,
      description: `${id} fixture category`,
      enabled: true
    });
    const card = (id, categoryId) => ({
      id,
      categoryId,
      name: id,
      description: `${id} fixture card`,
      promptText: `Apply fixture ${id}.`,
      enabled: true
    });
    const deckFrom = (categoryIds) => ({
      id: 'live-fixture-post-process',
      name: 'Live Fixture Post-process',
      categoryOrder: [...categoryIds],
      categories: Object.fromEntries(categoryIds.map((id) => [id, category(id)])),
      cardOrderByCategory: Object.fromEntries(
        categoryIds.map((id) => [id, [`${id}-card`]])
      ),
      cards: Object.fromEntries(
        categoryIds.map((id) => [`${id}-card`, card(`${id}-card`, id)])
      )
    });
    const settings = (rewriteFlow) => ({
      reasoningLevel: 'medium',
      modelAttemptsPerStep: 2,
      postProcess: {
        enabled: true,
        applyMode: 'as-swipe',
        rewriteFlow,
        contextMessages: 13
      },
      postProcessDecks: {
        activeDeckId: 'live-fixture-post-process',
        customDecks: {}
      }
    });
    const sourceSnapshot = (chatKey) => ({
      chatKey,
      chatIdentityHash: `${chatKey}-identity`,
      sourceMessageId: 7,
      sourceSwipeId: 0,
      sourceHash: `${chatKey}-source`,
      snapshotHash: `${chatKey}-snapshot`,
      originalDraft: 'Fixture original response.',
      activeCharacterHash: 'fixture-character',
      activeGroupHash: '',
      supportingContext: {
        latestUserMessage: 'Fixture user message.',
        boundedPriorMessages: ['Fixture prior evidence.'],
        characterContext: 'Fixture character context.',
        preProcessPromptPacket: { packetId: 'fixture-packet' },
        storyForm: { tense: 'past', pov: 'third-person-limited' }
      }
    });
    const guidanceRouter = (calls) => ({
      async generate(roleId, request) {
        calls.push({
          roleId,
          categoryIds: Array.isArray(request.categoryIds)
            ? [...request.categoryIds]
            : []
        });
        return {
          ok: true,
          data: {
            schema: 'recursion.postProcessGuidance.v1',
            snapshotHash: request.snapshotHash,
            sourceHash: request.sourceHash,
            guidanceText: 'Fixture post-process guidance.'
          }
        };
      }
    });

    const unifiedStorage = createStorageRepository({
      storage: createMemoryStorageAdapter()
    });
    const unifiedSnapshot = sourceSnapshot('live-unified');
    const unifiedSettingsStore = { get: () => settings('unified') };
    const unifiedGuidanceCalls = [];
    const unifiedRewriteCalls = [];
    const unifiedCommitCalls = [];
    const firstUnifiedRewrite = deferred();
    const firstUnifiedScheduler = createExecutionScheduler({
      repository: unifiedStorage,
      attemptsPerStep: 2
    });
    const firstUnifiedRuntime = createPostProcessRuntime({
      host: {
        generation: {
          async rewriteWithPostProcess(input) {
            unifiedRewriteCalls.push({ phase: 'before-reload', hasGuidance: Boolean(input.guidancePacket) });
            return firstUnifiedRewrite.promise;
          }
        }
      },
      generationRouter: guidanceRouter(unifiedGuidanceCalls),
      settingsStore: unifiedSettingsStore,
      snapshotProvider: async () => unifiedSnapshot,
      deckProvider: async () => deckFrom(['natural-prose']),
      sourceGuard: async () => true,
      commitResult: async () => {
        unifiedCommitCalls.push({ committed: true });
        return { ok: true };
      },
      durableExecution: {
        scheduler: firstUnifiedScheduler,
        repository: unifiedStorage
      }
    });
    const unifiedRunning = firstUnifiedRuntime.runPostProcessForLatestAssistant();
    await waitUntil(
      () => unifiedRewriteCalls.length === 1,
      'Unified fixture did not reach rewrite.'
    );
    firstUnifiedRuntime.cancelPostProcess('user');
    firstUnifiedRewrite.resolve({
      ok: true,
      text: 'Late fixture rewrite must not commit.'
    });
    const unifiedPausedResult = await unifiedRunning;
    const unifiedPaused = await unifiedStorage.loadPipelineRun(unifiedSnapshot.chatKey);
    const unifiedCountsBeforeRestore = {
      guidance: unifiedGuidanceCalls.length,
      rewrite: unifiedRewriteCalls.length,
      commit: unifiedCommitCalls.length
    };
    const secondUnifiedScheduler = createExecutionScheduler({
      repository: unifiedStorage,
      attemptsPerStep: 2
    });
    const secondUnifiedRuntime = createPostProcessRuntime({
      host: {
        generation: {
          async rewriteWithPostProcess(input) {
            unifiedRewriteCalls.push({ phase: 'after-reload', hasGuidance: Boolean(input.guidancePacket) });
            return { ok: true, text: 'Resumed fixture rewrite.' };
          }
        }
      },
      generationRouter: guidanceRouter(unifiedGuidanceCalls),
      settingsStore: unifiedSettingsStore,
      snapshotProvider: async () => unifiedSnapshot,
      deckProvider: async () => deckFrom(['natural-prose']),
      sourceGuard: async () => true,
      commitResult: async () => {
        unifiedCommitCalls.push({ committed: true });
        return { ok: true };
      },
      durableExecution: {
        scheduler: secondUnifiedScheduler,
        repository: unifiedStorage
      }
    });
    await secondUnifiedRuntime.restoreExecutionState(unifiedPaused);
    const unifiedCountsAfterRestore = {
      guidance: unifiedGuidanceCalls.length,
      rewrite: unifiedRewriteCalls.length,
      commit: unifiedCommitCalls.length
    };
    const unifiedCompleted = await secondUnifiedRuntime.resumeOperation({
      operationId: unifiedPaused.operationId
    });
    const unifiedDuplicate = await secondUnifiedRuntime.resumeOperation({
      operationId: unifiedPaused.operationId
    });
    const unifiedManifest = await unifiedStorage.loadPipelineRun(unifiedSnapshot.chatKey);

    const progressiveStorage = createStorageRepository({
      storage: createMemoryStorageAdapter()
    });
    const progressiveSnapshot = sourceSnapshot('live-progressive');
    const progressiveSettingsStore = { get: () => settings('progressive') };
    const progressiveGuidanceCalls = [];
    const progressiveRewriteCalls = [];
    const progressiveCommitCalls = [];
    const firstProgressiveSecondRewrite = deferred();
    const firstProgressiveScheduler = createExecutionScheduler({
      repository: progressiveStorage,
      attemptsPerStep: 2
    });
    const firstProgressiveRuntime = createPostProcessRuntime({
      host: {
        generation: {
          async rewriteWithPostProcess() {
            const call = progressiveRewriteCalls.length + 1;
            progressiveRewriteCalls.push({ call, phase: 'before-reload' });
            if (call === 1) {
              return { ok: true, text: 'Fixture draft after first category.' };
            }
            return firstProgressiveSecondRewrite.promise;
          }
        }
      },
      generationRouter: guidanceRouter(progressiveGuidanceCalls),
      settingsStore: progressiveSettingsStore,
      snapshotProvider: async () => progressiveSnapshot,
      deckProvider: async () => deckFrom(['natural-prose', 'dialogue']),
      sourceGuard: async () => true,
      commitResult: async () => {
        progressiveCommitCalls.push({ committed: true });
        return { ok: true };
      },
      durableExecution: {
        scheduler: firstProgressiveScheduler,
        repository: progressiveStorage
      }
    });
    const progressiveRunning = firstProgressiveRuntime.runPostProcessForLatestAssistant();
    await waitUntil(
      () => progressiveRewriteCalls.length === 2,
      'Progressive fixture did not reach second-category rewrite.'
    );
    firstProgressiveRuntime.cancelPostProcess('user');
    firstProgressiveSecondRewrite.resolve({
      ok: true,
      text: 'Late progressive fixture rewrite must not commit.'
    });
    const progressivePausedResult = await progressiveRunning;
    const progressivePaused = await progressiveStorage.loadPipelineRun(
      progressiveSnapshot.chatKey
    );
    const progressiveCountsBeforeRestore = {
      guidance: progressiveGuidanceCalls.length,
      rewrite: progressiveRewriteCalls.length,
      commit: progressiveCommitCalls.length
    };
    const secondProgressiveScheduler = createExecutionScheduler({
      repository: progressiveStorage,
      attemptsPerStep: 2
    });
    const secondProgressiveRuntime = createPostProcessRuntime({
      host: {
        generation: {
          async rewriteWithPostProcess() {
            const call = progressiveRewriteCalls.length + 1;
            progressiveRewriteCalls.push({ call, phase: 'after-reload' });
            return { ok: true, text: 'Final progressive fixture draft.' };
          }
        }
      },
      generationRouter: guidanceRouter(progressiveGuidanceCalls),
      settingsStore: progressiveSettingsStore,
      snapshotProvider: async () => progressiveSnapshot,
      deckProvider: async () => deckFrom(['natural-prose', 'dialogue']),
      sourceGuard: async () => true,
      commitResult: async () => {
        progressiveCommitCalls.push({ committed: true });
        return { ok: true };
      },
      durableExecution: {
        scheduler: secondProgressiveScheduler,
        repository: progressiveStorage
      }
    });
    await secondProgressiveRuntime.restoreExecutionState(progressivePaused);
    const progressiveCountsAfterRestore = {
      guidance: progressiveGuidanceCalls.length,
      rewrite: progressiveRewriteCalls.length,
      commit: progressiveCommitCalls.length
    };
    const progressiveCompleted = await secondProgressiveRuntime.resumeOperation({
      operationId: progressivePaused.operationId
    });
    const progressiveManifest = await progressiveStorage.loadPipelineRun(
      progressiveSnapshot.chatKey
    );

    return {
      unified: {
        pausedResult: {
          paused: unifiedPausedResult?.paused === true,
          committed: unifiedPausedResult?.committed === true
        },
        pausedState: unifiedPaused?.state || '',
        pausedStages: Object.fromEntries(
          Object.entries(unifiedPaused?.stageRecords || {})
            .map(([id, record]) => [id, record.state])
        ),
        countsBeforeRestore: unifiedCountsBeforeRestore,
        countsAfterRestore: unifiedCountsAfterRestore,
        completed: {
          committed: unifiedCompleted?.committed === true,
          state: unifiedManifest?.state || ''
        },
        duplicate: {
          committed: unifiedDuplicate?.committed === true,
          commitCalls: unifiedCommitCalls.length
        },
        finalCounts: {
          guidance: unifiedGuidanceCalls.length,
          rewrite: unifiedRewriteCalls.length,
          commit: unifiedCommitCalls.length
        }
      },
      progressive: {
        pausedResult: {
          paused: progressivePausedResult?.paused === true,
          committed: progressivePausedResult?.committed === true
        },
        pausedState: progressivePaused?.state || '',
        pausedStages: Object.fromEntries(
          Object.entries(progressivePaused?.stageRecords || {})
            .map(([id, record]) => [id, record.state])
        ),
        countsBeforeRestore: progressiveCountsBeforeRestore,
        countsAfterRestore: progressiveCountsAfterRestore,
        completed: {
          committed: progressiveCompleted?.committed === true,
          state: progressiveManifest?.state || ''
        },
        finalCounts: {
          guidance: progressiveGuidanceCalls.length,
          rewrite: progressiveRewriteCalls.length,
          commit: progressiveCommitCalls.length
        }
      }
    };
  });
  assertEqual(proof.unified.pausedResult.paused, true, 'Unified Stop must pause.', proof);
  assertEqual(proof.unified.pausedState, 'paused', 'Unified manifest must persist paused.', proof);
  assertEqual(
    proof.unified.pausedStages['postprocess.unified.guidance'],
    'completed',
    'Unified guidance must survive interruption.',
    proof
  );
  assertEqual(
    proof.unified.pausedStages['postprocess.unified.rewrite'],
    'pending',
    'Interrupted Unified rewrite must return to pending.',
    proof
  );
  assertEqual(
    JSON.stringify(proof.unified.countsAfterRestore),
    JSON.stringify(proof.unified.countsBeforeRestore),
    'Unified reload restoration must execute no work.',
    proof
  );
  assertEqual(proof.unified.completed.committed, true, 'Unified Resume must commit.', proof);
  assertEqual(proof.unified.completed.state, 'completed', 'Unified Resume must complete.', proof);
  assertEqual(proof.unified.finalCounts.guidance, 1, 'Unified Resume must reuse guidance.', proof);
  assertEqual(proof.unified.finalCounts.rewrite, 2, 'Unified Resume must rerun only rewrite.', proof);
  assertEqual(proof.unified.finalCounts.commit, 1, 'Unified completion must mutate host once.', proof);
  assertEqual(proof.unified.duplicate.commitCalls, 1, 'Duplicate Resume must not duplicate commit.', proof);

  assertEqual(proof.progressive.pausedResult.paused, true, 'Progressive Stop must pause.', proof);
  assertEqual(proof.progressive.pausedState, 'paused', 'Progressive manifest must persist paused.', proof);
  assertEqual(
    proof.progressive.pausedStages['postprocess.natural-prose.rewrite'],
    'completed',
    'Progressive first draft must survive interruption.',
    proof
  );
  assertEqual(
    proof.progressive.pausedStages['postprocess.dialogue.guidance'],
    'completed',
    'Progressive active-category guidance must survive interruption.',
    proof
  );
  assertEqual(
    proof.progressive.pausedStages['postprocess.dialogue.rewrite'],
    'pending',
    'Interrupted Progressive rewrite must return to pending.',
    proof
  );
  assertEqual(
    JSON.stringify(proof.progressive.countsAfterRestore),
    JSON.stringify(proof.progressive.countsBeforeRestore),
    'Progressive reload restoration must execute no work.',
    proof
  );
  assertEqual(
    proof.progressive.completed.committed,
    true,
    'Progressive Resume must commit.',
    proof
  );
  assertEqual(
    proof.progressive.completed.state,
    'completed',
    'Progressive Resume must complete.',
    proof
  );
  assertEqual(
    proof.progressive.finalCounts.guidance,
    2,
    'Progressive Resume must reuse both guidance checkpoints.',
    proof
  );
  assertEqual(
    proof.progressive.finalCounts.rewrite,
    3,
    'Progressive Resume must reuse the first draft and rerun only the interrupted rewrite.',
    proof
  );
  assertEqual(
    proof.progressive.finalCounts.commit,
    1,
    'Progressive completion must mutate host once.',
    proof
  );
  return proof;
}

function publicSummary(result) {
  const pickExecution = (summary) => ({
    state: summary?.execution?.state || null,
    pauseReason: summary?.execution?.pauseReason || '',
    stageStates: summary?.execution?.stageStates || {},
    callCounts: summary?.callCounts || {},
    queued: summary?.queued || null,
    activity: summary?.activity || {}
  });
  return {
    segmented: {
      paused: pickExecution(result.segmented.paused),
      reloaded: pickExecution(result.segmented.reloaded),
      resumed: pickExecution(result.segmented.resumed)
    },
    recovery: {
      queued: pickExecution(result.recovery.queued),
      failed: pickExecution(result.recovery.failed),
      retried: pickExecution(result.recovery.retried),
      canceled: pickExecution(result.recovery.canceled),
      fullFresh: pickExecution(result.recovery.fresh)
    },
    fused: {
      partial: pickExecution(result.fused.partial),
      zeroUseful: pickExecution(result.fused.zero)
    },
    promptFailure: {
      result: result.prompt.result,
      execution: pickExecution(result.prompt.failure),
      reset: pickExecution(result.prompt.reset)
    },
    postProcess: result.postProcess,
    ui: result.ui
  };
}

async function main() {
  const env = process.env;
  const user = assertPreflight(process.argv.slice(2), env);
  const timeoutMs = Number(env.RECURSION_LIVE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const runId = createRunId('resumable-pipeline-proof');
  const artifactDir = resolve('artifacts', 'live-resumable-pipeline', runId);
  mkdirSync(artifactDir, { recursive: true });
  const session = createSillyTavernHttpSession({
    baseUrl: env.SILLYTAVERN_BASE_URL,
    user,
    password: passwordForUser(user, env)
  });
  await session.init();
  await session.login();
  const browser = await chromium.launch({
    headless: env.RECURSION_SILLYTAVERN_HEADLESS !== '0'
  });
  let page;
  try {
    const context = await browser.newContext({
      viewport: { width: 1360, height: 820 }
    });
    await context.addCookies(session.playwrightCookies());
    await context.addInitScript(() => {
      globalThis.__recursionLiveHarness = true;
    });
    page = await context.newPage();
    await page.goto(env.SILLYTAVERN_BASE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs
    });
    console.error('[live-proof] host page loaded');
    await waitForRuntime(page, timeoutMs);
    console.error('[live-proof] runtime available');
    await installProviderFixture(page);
    console.error('[live-proof] fixture installed');
    const result = {
      segmented: await proveSegmentedPauseReloadResume(page, timeoutMs),
      recovery: await proveRetryReprocessAndFresh(page),
      fused: await proveFused(page, timeoutMs),
      prompt: await provePromptInstallFailureAndReset(page),
      postProcess: await provePostProcessFixtures(page),
      ui: await inspectProgressUi(page)
    };
    await page.evaluate(async () => {
      await globalThis.__recursionLiveHarnessRuntime.resetSceneCache();
    });
    const report = {
      status: 'pass',
      result: 'live-resumable-pipeline-pass',
      user,
      runId,
      provider: 'deterministic in-page fixture; no external model calls',
      proof: publicSummary(result)
    };
    const reportPath = resolve(artifactDir, 'report.json');
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      ...report,
      reportPath
    }, null, 2));
  } finally {
    if (page) await restoreProviderFixture(page);
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: 'fail',
    result: error.result || 'live-resumable-pipeline-error',
    error: error.message,
    details: error.details || null
  }, null, 2));
  process.exit(1);
});
