import {
  buildPostProcessPlan,
  createPostProcessRuntime
} from '../../src/post-process-runtime.mjs';
import { createActivityReporter } from '../../src/activity.mjs';
import { hashJson } from '../../src/core.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

const GUIDANCE_SCHEMA = 'recursion.postProcessGuidance.v1';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate, message, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

function card(id, categoryId, promptText = `Apply ${id}.`) {
  return {
    id,
    categoryId,
    name: id,
    description: `${id} description`,
    promptText,
    enabled: true
  };
}

function category(id) {
  return {
    id,
    name: id,
    description: `${id} description`,
    enabled: true
  };
}

function deckFrom(categoryIds = ['natural-prose']) {
  const categories = Object.fromEntries(categoryIds.map((id) => [id, category(id)]));
  const cards = Object.fromEntries(categoryIds.map((id) => [`${id}-card`, card(`${id}-card`, id)]));
  return {
    id: 'test-post-process-deck',
    name: 'Test Post-process Deck',
    categoryOrder: [...categoryIds],
    categories,
    cardOrderByCategory: Object.fromEntries(categoryIds.map((id) => [id, [`${id}-card`]])),
    cards
  };
}

function settings(overrides = {}) {
  return {
    reasoningLevel: 'medium',
    postProcess: {
      enabled: true,
      applyMode: 'as-swipe',
      rewriteFlow: 'unified',
      contextMessages: 13,
      ...overrides.postProcess
    },
    postProcessDecks: {
      activeDeckId: 'test-post-process-deck',
      customDecks: {},
      ...overrides.postProcessDecks
    },
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) => !['postProcess', 'postProcessDecks'].includes(key))
    )
  };
}

function snapshot(overrides = {}) {
  return {
    chatKey: 'post-process-chat',
    chatIdentityHash: 'post-process-chat-identity-hash',
    sourceMessageId: 7,
    sourceSwipeId: 0,
    sourceHash: 'source-hash-v1',
    snapshotHash: 'snapshot-hash-v1',
    originalDraft: 'original',
    activeCharacterHash: 'character-hash-1',
    activeGroupHash: '',
    supportingContext: {
      latestUserMessage: 'Continue.',
      boundedPriorMessages: ['Prior scene evidence.'],
      characterContext: 'Mara speaks plainly.',
      preProcessPromptPacket: { packetId: 'pre-process-packet' },
      storyForm: { tense: 'past', pov: 'third-person-limited' }
    },
    ...overrides
  };
}

async function normalizeGuidanceAttempt(value, request, callIndex, attempt) {
  let resolved = value;
  if (typeof resolved === 'function') {
    resolved = resolved({ request, callIndex, attempt });
  }
  if (resolved && typeof resolved.then === 'function') {
    resolved = await resolved;
  }
  value = resolved;
  if (value === false || value?.ok === false) {
    return {
      ok: false,
      error: {
        code: value?.error?.code || 'RECURSION_TEST_GUIDANCE_FAILED',
        message: value?.error?.message || 'Guidance failed.'
      }
    };
  }
  const guidanceText = typeof value === 'string'
    ? value
    : (value?.guidanceText || `guidance-${callIndex + 1}`);
  return {
    ok: true,
    data: {
      schema: GUIDANCE_SCHEMA,
      snapshotHash: request.snapshotHash,
      sourceHash: request.sourceHash,
      guidanceText
    }
  };
}

async function normalizeHostAttempt(value, callIndex) {
  let resolved = value;
  if (typeof resolved === 'function') resolved = resolved({ callIndex });
  if (resolved && typeof resolved.then === 'function') resolved = await resolved;
  value = resolved;
  if (value === false || value?.ok === false) {
    return {
      ok: false,
      text: '',
      error: {
        code: value?.error?.code || 'RECURSION_TEST_HOST_FAILED',
        message: value?.error?.message || 'Host rewrite failed.'
      }
    };
  }
  if (value && typeof value === 'object') return value;
  return { ok: true, text: value === undefined ? `rewrite-${callIndex + 1}` : String(value) };
}

function createHarness({
  initialSettings = settings(),
  initialDeck = deckFrom(),
  initialSnapshot = snapshot(),
  guidancePlan = [],
  hostPlan = [],
  sourceGuard = async () => true,
  commitImpl = async () => ({ ok: true }),
  activity = null
} = {}) {
  const settingsRef = { current: initialSettings };
  const deckRef = { current: initialDeck };
  const snapshotRef = { current: initialSnapshot };
  const guidanceInputs = [];
  const generationRouterCalls = [];
  const guidanceAttempts = [];
  const hostCalls = [];
  const commitCalls = [];
  const guardCalls = [];

  const generationRouter = {
    async generate(roleId, request, options = {}) {
      const callIndex = generationRouterCalls.length;
      generationRouterCalls.push({ roleId, request, options });
      guidanceInputs.push(request);
      const attempts = Array.isArray(guidancePlan[callIndex])
        ? guidancePlan[callIndex]
        : [guidancePlan[callIndex] ?? true];
      let lastFailure = null;
      for (let attempt = 1; attempt <= Number(options.maxAttempts || 1); attempt += 1) {
        guidanceAttempts.push({ roleId, lane: request.lane, callIndex, attempt });
        const planned = attempts[Math.min(attempt - 1, attempts.length - 1)];
        const result = await normalizeGuidanceAttempt(planned, request, callIndex, attempt);
        if (result?.ok === true) {
          return {
            ...result,
            roleId,
            lane: request.lane,
            diagnostics: { retryCount: attempt - 1 }
          };
        }
        lastFailure = result;
      }
      return {
        ...(lastFailure || { ok: false }),
        roleId,
        lane: request.lane,
        diagnostics: { retryCount: Math.max(0, Number(options.maxAttempts || 1) - 1) }
      };
    }
  };

  const host = {
    generation: {
      async rewriteWithPostProcess(input) {
        const callIndex = hostCalls.length;
        hostCalls.push(input);
        return normalizeHostAttempt(hostPlan[callIndex], callIndex);
      }
    }
  };

  const runtime = createPostProcessRuntime({
    host,
    generationRouter,
    settingsStore: {
      get() {
        return structuredClone(settingsRef.current);
      }
    },
    snapshotProvider: async () => structuredClone(snapshotRef.current),
    deckProvider: () => deckRef.current,
    activity,
    async sourceGuard(input) {
      guardCalls.push(input);
      return sourceGuard(input);
    },
    async commitResult(input) {
      commitCalls.push(input);
      return commitImpl(input);
    }
  });

  return {
    runtime,
    settingsRef,
    deckRef,
    snapshotRef,
    guidanceInputs,
    generationRouterCalls,
    guidanceAttempts,
    hostCalls,
    commitCalls,
    guardCalls
  };
}

const cases = [];
function test(name, run) {
  cases.push({ name, run });
}

test('1. Off makes no guidance, host, or commit calls', async () => {
  const harness = createHarness({
    initialSettings: settings({ postProcess: { enabled: false } })
  });
  const result = await harness.runtime.runPostProcessForLatestAssistant();
  assertEqual(result.committed, false, 'Off leaves the original unchanged');
  assertEqual(result.reason, 'disabled', 'Off returns the stable disabled reason');
  assertEqual(harness.generationRouterCalls.length, 0, 'Off makes no guidance call');
  assertEqual(harness.hostCalls.length, 0, 'Off makes no host call');
  assertEqual(harness.commitCalls.length, 0, 'Off makes no commit call');
});

test('1a. A host-triggered run without its verified operation token fails soft', async () => {
  const harness = createHarness();
  const result = await harness.runtime.runPostProcessForLatestAssistant({
    hostTriggered: true,
    operationToken: 'missing-operation-token'
  });
  assertEqual(result.committed, false, 'unbound host-triggered run leaves the original unchanged');
  assertEqual(result.reason, 'post-process-arm-canceled', 'unbound host-triggered run returns the stable canceled-arm reason');
  assertEqual(harness.generationRouterCalls.length, 0, 'unbound host-triggered run makes no guidance call');
  assertEqual(harness.hostCalls.length, 0, 'unbound host-triggered run makes no host rewrite call');
  assertEqual(harness.commitCalls.length, 0, 'unbound host-triggered run makes no commit call');
});

test('2. No runnable cards makes no guidance, host, or commit calls', async () => {
  const deck = deckFrom();
  deck.cards['natural-prose-card'].promptText = '  ';
  const harness = createHarness({ initialDeck: deck });
  const result = await harness.runtime.runPostProcessForLatestAssistant();
  assertEqual(result.committed, false, 'no runnable cards leaves the original unchanged');
  assertEqual(result.reason, 'no-runnable-cards', 'no runnable cards returns a stable reason');
  assertEqual(harness.generationRouterCalls.length, 0, 'no runnable cards makes no guidance call');
  assertEqual(harness.hostCalls.length, 0, 'no runnable cards makes no host call');
  assertEqual(harness.commitCalls.length, 0, 'no runnable cards makes no commit call');
});

test('3. Unified makes one guidance call, one host call, and one final candidate', async () => {
  const harness = createHarness({ hostPlan: ['unified rewrite'] });
  const result = await harness.runtime.runPostProcessForLatestAssistant();
  assertEqual(harness.generationRouterCalls.length, 1, 'Unified makes one guidance call');
  assertEqual(harness.hostCalls.length, 1, 'Unified makes one host call');
  assertEqual(harness.commitCalls.length, 1, 'Unified commits one final candidate');
  assertEqual(harness.commitCalls[0].text, 'unified rewrite', 'Unified commits the host candidate');
  assertEqual(result.candidate, 'unified rewrite', 'Unified returns its one final candidate');
});

test('4. Unified guidance recovery stays in one router call with two same-role attempts', async () => {
  const harness = createHarness({
    guidancePlan: [[false, 'recovered guidance']],
    hostPlan: ['recovered rewrite']
  });
  const result = await harness.runtime.runPostProcessForLatestAssistant();
  assertEqual(result.committed, true, 'recovered Unified guidance commits');
  assertEqual(harness.generationRouterCalls.length, 1, 'orchestrator delegates the guidance retry budget once');
  assertEqual(harness.generationRouterCalls[0].options.maxAttempts, 2, 'guidance router gets exactly two attempts');
  assertDeepEqual(
    harness.guidanceAttempts.map(({ roleId, lane }) => [roleId, lane]),
    [
      ['postProcessGuidanceUtility', 'utility'],
      ['postProcessGuidanceUtility', 'utility']
    ],
    'guidance retry keeps the frozen role and lane'
  );
  assertEqual(harness.hostCalls.length, 1, 'recovered guidance makes one host call');
});

test('5. Unified total guidance failure makes no host call and no commit', async () => {
  const harness = createHarness({ guidancePlan: [[false, false]] });
  const result = await harness.runtime.runPostProcessForLatestAssistant();
  assertEqual(result.committed, false, 'total guidance failure does not commit');
  assertEqual(harness.hostCalls.length, 0, 'total guidance failure makes no host call');
  assertEqual(harness.commitCalls.length, 0, 'total guidance failure makes no commit call');
  assertEqual(result.outcomes[0].failureStage, 'guidance', 'guidance failure records its structural stage');
});

test('6. Unified host recovery reuses guidance and two identical host packets', async () => {
  const harness = createHarness({
    hostPlan: [false, 'host retry rewrite']
  });
  const result = await harness.runtime.runPostProcessForLatestAssistant();
  assertEqual(result.committed, true, 'host retry success commits');
  assertEqual(harness.generationRouterCalls.length, 1, 'host retry never reruns guidance');
  assertEqual(harness.hostCalls.length, 2, 'host rewrite gets exactly two attempts');
  assertEqual(
    harness.hostCalls[0].guidancePacket,
    harness.hostCalls[1].guidancePacket,
    'host retry receives the identical packet'
  );
  assertEqual(
    harness.hostCalls[0].writerDirective,
    harness.hostCalls[1].writerDirective,
    'host retry receives the identical writer directive'
  );
});

test('7. Unified total host failure makes no commit', async () => {
  const harness = createHarness({ hostPlan: [false, false] });
  const result = await harness.runtime.runPostProcessForLatestAssistant();
  assertEqual(result.committed, false, 'total host failure does not commit');
  assertEqual(harness.generationRouterCalls.length, 1, 'total host failure uses one guidance result');
  assertEqual(harness.hostCalls.length, 2, 'total host failure exhausts two host attempts');
  assertEqual(harness.commitCalls.length, 0, 'total host failure makes no commit call');
});

test('8. Progressive runs two categories in order', async () => {
  const harness = createHarness({
    initialSettings: settings({ postProcess: { rewriteFlow: 'progressive' } }),
    initialDeck: deckFrom(['natural-prose', 'follow-through']),
    hostPlan: ['rewrite after natural prose', 'rewrite after follow through']
  });
  const result = await harness.runtime.runPostProcessForLatestAssistant();
  assertEqual(result.committed, true, 'Progressive complete result commits');
  assertEqual(harness.generationRouterCalls.length, 2, 'Progressive makes one guidance call per category');
  assertEqual(harness.hostCalls.length, 2, 'Progressive makes one host call per category');
  assertDeepEqual(
    result.outcomes.map((outcome) => outcome.categoryId),
    ['natural-prose', 'follow-through'],
    'Progressive outcomes keep deck order'
  );
});

test('9. Progressive category two receives category one rewrite', async () => {
  const harness = createHarness({
    initialSettings: settings({ postProcess: { rewriteFlow: 'progressive' } }),
    initialDeck: deckFrom(['natural-prose', 'follow-through']),
    hostPlan: ['rewrite after natural prose', 'rewrite after follow through']
  });
  await harness.runtime.runPostProcessForLatestAssistant();
  assertEqual(harness.guidanceInputs[0].draft, 'original', 'category one receives the original');
  assertEqual(
    harness.guidanceInputs[1].draft,
    'rewrite after natural prose',
    'category two receives category one rewrite, not the original'
  );
});

test('10. Progressive categories receive the identical frozen evidence and hash', async () => {
  const harness = createHarness({
    initialSettings: settings({ postProcess: { rewriteFlow: 'progressive' } }),
    initialDeck: deckFrom(['natural-prose', 'follow-through']),
    hostPlan: ['rewrite after natural prose', 'rewrite after follow through']
  });
  await harness.runtime.runPostProcessForLatestAssistant();
  assertEqual(
    harness.guidanceInputs[0].supportingContext,
    harness.guidanceInputs[1].supportingContext,
    'Progressive categories share the identical frozen supporting context object'
  );
  assertEqual(
    harness.guidanceInputs[0].snapshotHash,
    harness.guidanceInputs[1].snapshotHash,
    'Progressive categories share the identical frozen snapshot hash'
  );
  assert(Object.isFrozen(harness.guidanceInputs[0].supportingContext), 'supporting context is frozen');
});

test('11. Progressive guidance failure carries the last valid draft forward', async () => {
  const harness = createHarness({
    initialSettings: settings({ postProcess: { rewriteFlow: 'progressive' } }),
    initialDeck: deckFrom(['natural-prose', 'follow-through']),
    guidancePlan: [[false, false], [true]],
    hostPlan: ['rewrite after follow through']
  });
  const result = await harness.runtime.runPostProcessForLatestAssistant();
  assertEqual(
    harness.guidanceInputs[1].draft,
    'original',
    'later category receives the last valid draft after guidance failure'
  );
  assertEqual(result.partial, true, 'one failed and one successful category is partial');
  assertEqual(result.candidate, 'rewrite after follow through', 'later category can still produce the candidate');
});

test('12. Progressive host failure carries the last valid draft forward', async () => {
  const harness = createHarness({
    initialSettings: settings({ postProcess: { rewriteFlow: 'progressive' } }),
    initialDeck: deckFrom(['natural-prose', 'follow-through']),
    hostPlan: [false, false, 'rewrite after follow through']
  });
  const result = await harness.runtime.runPostProcessForLatestAssistant();
  assertEqual(
    harness.guidanceInputs[1].draft,
    'original',
    'later category receives the last valid draft after host failure'
  );
  assertEqual(result.partial, true, 'host category failure makes the later success partial');
  assertEqual(harness.commitCalls.length, 1, 'partial valid draft commits once');
});

test('13. Partial result forces As Swipe when Replace was requested', async () => {
  const harness = createHarness({
    initialSettings: settings({
      postProcess: { rewriteFlow: 'progressive', applyMode: 'replace' }
    }),
    initialDeck: deckFrom(['natural-prose', 'follow-through']),
    guidancePlan: [[false, false], [true]],
    hostPlan: ['partial rewrite']
  });
  const result = await harness.runtime.runPostProcessForLatestAssistant();
  assertEqual(result.partial, true, 'result is explicitly partial');
  assertEqual(result.requestedApplyMode, 'replace', 'result retains requested Replace');
  assertEqual(result.committedApplyMode, 'as-swipe', 'partial result forces As Swipe');
  assertEqual(harness.commitCalls[0].mode, 'as-swipe', 'commit boundary receives forced As Swipe');
});

test('14. All Progressive categories failing makes no commit', async () => {
  const harness = createHarness({
    initialSettings: settings({ postProcess: { rewriteFlow: 'progressive' } }),
    initialDeck: deckFrom(['natural-prose', 'follow-through']),
    guidancePlan: [[false, false], [false, false]]
  });
  const result = await harness.runtime.runPostProcessForLatestAssistant();
  assertEqual(result.committed, false, 'all-category failure does not commit');
  assertEqual(result.reason, 'all-stages-failed', 'all-category failure has a stable reason');
  assertEqual(harness.commitCalls.length, 0, 'all-category failure makes no commit call');
});

test('15. Complete Replace commits the final candidate in place', async () => {
  const harness = createHarness({
    initialSettings: settings({ postProcess: { applyMode: 'replace' } }),
    hostPlan: ['replacement candidate']
  });
  const result = await harness.runtime.runPostProcessForLatestAssistant();
  assertEqual(result.partial, false, 'complete Replace is not partial');
  assertEqual(result.committedApplyMode, 'replace', 'complete Replace keeps Replace mode');
  assertEqual(harness.commitCalls[0].mode, 'replace', 'commit boundary receives Replace');
  assertEqual(harness.commitCalls[0].text, 'replacement candidate', 'Replace commits final candidate');
});

test('16. Stop aborts the operation and prevents commit', async () => {
  const guidanceGate = deferred();
  const harness = createHarness({
    guidancePlan: [[guidanceGate.promise]],
    hostPlan: ['must not be used']
  });
  const running = harness.runtime.runPostProcessForLatestAssistant();
  await waitUntil(
    () => harness.generationRouterCalls.length === 1,
    'stop fixture guidance did not start'
  );
  const canceled = harness.runtime.cancelPostProcess();
  assertEqual(canceled.canceled, true, 'cancel reports an active operation');
  guidanceGate.resolve(true);
  const result = await running;
  assertEqual(result.committed, false, 'stopped operation does not commit');
  assertEqual(result.reason, 'canceled', 'stopped operation returns canceled');
  assertEqual(harness.hostCalls.length, 0, 'stopped operation does not proceed to host rewrite');
  assertEqual(harness.commitCalls.length, 0, 'stopped operation makes no commit call');
});

test('17. Stale source before final commit makes no commit', async () => {
  const harness = createHarness({
    hostPlan: ['stale candidate'],
    sourceGuard: async () => false
  });
  const result = await harness.runtime.runPostProcessForLatestAssistant();
  assertEqual(result.committed, false, 'stale source does not commit');
  assertEqual(result.reason, 'stale-source', 'stale source returns a stable reason');
  assertEqual(harness.guardCalls.length, 1, 'source guard runs immediately before commit');
  assertEqual(harness.commitCalls.length, 0, 'stale source makes no commit call');
});

test('18. Empty and exact-no-op host outputs consume both retries and fail soft', async () => {
  const harness = createHarness({
    hostPlan: ['', 'original']
  });
  const result = await harness.runtime.runPostProcessForLatestAssistant();
  assertEqual(result.committed, false, 'empty and no-op outputs do not commit');
  assertEqual(harness.hostCalls.length, 2, 'empty and no-op outputs consume both host attempts');
  assertEqual(harness.commitCalls.length, 0, 'empty and no-op outputs make no commit call');
  assertEqual(result.outcomes[0].failureStage, 'host-rewrite', 'unusable output fails at host stage');
});

test('19. Settings and deck mutation cannot alter the frozen plan', async () => {
  const guidanceGate = deferred();
  const mutableSettings = settings({
    reasoningLevel: 'high',
    postProcess: { rewriteFlow: 'progressive', applyMode: 'replace' }
  });
  const mutableDeck = deckFrom(['natural-prose', 'follow-through']);
  const harness = createHarness({
    initialSettings: mutableSettings,
    initialDeck: mutableDeck,
    guidancePlan: [[guidanceGate.promise], [true]],
    hostPlan: ['rewrite after natural prose', 'rewrite after follow through']
  });
  const running = harness.runtime.runPostProcessForLatestAssistant();
  await waitUntil(
    () => harness.generationRouterCalls.length === 1,
    'mutation fixture guidance did not start'
  );

  harness.settingsRef.current.reasoningLevel = 'low';
  harness.settingsRef.current.postProcess.rewriteFlow = 'unified';
  harness.settingsRef.current.postProcess.applyMode = 'as-swipe';
  harness.deckRef.current.categoryOrder.reverse();
  harness.deckRef.current.categories['follow-through'].enabled = false;
  harness.deckRef.current.cards['natural-prose-card'].promptText = 'Mutated prompt.';
  guidanceGate.resolve(true);

  const result = await running;
  assertEqual(harness.generationRouterCalls.length, 2, 'frozen Progressive plan still runs two categories');
  assertDeepEqual(
    harness.guidanceAttempts.map(({ roleId }) => roleId),
    ['postProcessGuidanceReasoner', 'postProcessGuidanceReasoner'],
    'settings mutation cannot change the frozen role'
  );
  assertDeepEqual(
    result.outcomes.map(({ categoryId }) => categoryId),
    ['natural-prose', 'follow-through'],
    'deck mutation cannot change frozen category order or participation'
  );
  assertEqual(result.requestedApplyMode, 'replace', 'settings mutation cannot change requested apply mode');
  assertEqual(result.committedApplyMode, 'replace', 'complete frozen Replace remains Replace');
  assertEqual(
    harness.guidanceInputs[0].categories[0].cards[0].promptText,
    'Apply natural-prose-card.',
    'card prompt is frozen before mutation'
  );

  const rawChatId = 'PRIVATE/Frozen Chat ID.jsonl';
  const plan = buildPostProcessPlan({
    settings: mutableSettings,
    deck: mutableDeck,
    snapshot: snapshot({ chatId: rawChatId })
  });
  assert(Object.isFrozen(plan), 'pure plan is frozen');
  assert(Object.isFrozen(plan.snapshot.supportingContext), 'pure plan deeply freezes supporting context');
  assert(Object.isFrozen(plan.categories), 'pure plan deeply freezes category array');
  assert(!JSON.stringify(plan).includes(rawChatId), 'frozen plan never retains a raw chat id');
});

test('20. Returned diagnostics never contain raw prose, guidance, prompts, or context', async () => {
  const privateDeck = deckFrom(['private-failure', 'natural-prose']);
  privateDeck.cards['private-failure-card'].promptText = 'PRIVATE FAILURE CARD PROMPT';
  privateDeck.cards['natural-prose-card'].promptText = 'RAW CARD PROMPT';
  const harness = createHarness({
    initialSettings: settings({ postProcess: { rewriteFlow: 'progressive' } }),
    initialDeck: privateDeck,
    initialSnapshot: snapshot({
      originalDraft: 'RAW ORIGINAL PROSE',
      supportingContext: {
        latestUserMessage: 'RAW CONTEXT',
        boundedPriorMessages: [],
        characterContext: '',
        preProcessPromptPacket: null,
        storyForm: null
      }
    }),
    guidancePlan: [
      [{
        ok: false,
        error: {
          code: 'SECRET_PROSE_PAYLOAD',
          message: 'RAW FAILURE MESSAGE'
        }
      }],
      ['RAW GUIDANCE']
    ],
    hostPlan: ['RAW CANDIDATE PROSE'],
    commitImpl: async () => {
      const error = new Error('RAW COMMIT FAILURE MESSAGE');
      error.code = 'RAW_COMMIT_PROSE';
      throw error;
    }
  });
  const result = await harness.runtime.runPostProcessForLatestAssistant();
  const diagnostics = JSON.stringify(result.diagnostics);
  const latestDiagnostics = JSON.stringify(harness.runtime.postProcessDiagnostics());
  for (const raw of [
    'RAW ORIGINAL PROSE',
    'RAW CANDIDATE PROSE',
    'RAW GUIDANCE',
    'RAW CARD PROMPT',
    'RAW CONTEXT',
    'SECRET_PROSE_PAYLOAD',
    'RAW FAILURE MESSAGE',
    'PRIVATE FAILURE CARD PROMPT',
    'RAW_COMMIT_PROSE',
    'RAW COMMIT FAILURE MESSAGE'
  ]) {
    assert(!diagnostics.includes(raw), `result diagnostics omit ${raw}`);
    assert(!latestDiagnostics.includes(raw), `runtime diagnostics omit ${raw}`);
  }
  assertEqual(result.diagnostics.rewriteFlow, 'progressive', 'diagnostics retain safe rewrite flow');
  assertEqual(result.diagnostics.categories[0].categoryId, 'private-failure', 'diagnostics retain safe category id');
});

test('21. Final commit receives a structural marker bound to actual source and candidate text', async () => {
  const sourceText = 'Actual source response.';
  const candidateText = 'Actual revised response.';
  const harness = createHarness({
    initialSnapshot: snapshot({
      originalDraft: sourceText,
      sourceHash: hashJson(sourceText)
    }),
    hostPlan: [candidateText]
  });
  const result = await harness.runtime.runPostProcessForLatestAssistant();
  assertEqual(result.committed, true, 'marker fixture commits');
  const commit = harness.commitCalls[0];
  assertEqual(commit.markerNamespace, 'postProcess', 'commit uses the Post-process marker namespace');
  assertEqual(commit.marker.schema, 'recursion.postProcessMarker.v1', 'commit uses the V1 Post-process marker schema');
  assertEqual(commit.marker.sourceHash, hashJson(sourceText), 'marker source hash binds to actual source prose');
  assertEqual(commit.marker.candidateHash, hashJson(candidateText), 'marker candidate hash binds to actual candidate prose');
  const markerSerialized = JSON.stringify(commit.marker);
  assert(!markerSerialized.includes(sourceText), 'marker omits source prose');
  assert(!markerSerialized.includes(candidateText), 'marker omits candidate prose');
});

test('22. Arming is consumed once and cancellation aborts an active host rewrite', async () => {
  const hostGate = deferred();
  const events = [];
  const activity = createActivityReporter({ onEvent: (event) => events.push(event) });
  const harness = createHarness({
    hostPlan: [hostGate.promise],
    activity
  });
  assertEqual(
    harness.runtime.armPostProcess({ requireFinalTargetVerification: false }).armed,
    true,
    'Post-process operation arms'
  );
  assertEqual(harness.runtime.postProcessPending(), true, 'armed operation reports pending');
  const running = harness.runtime.runPostProcessForLatestAssistant();
  await waitUntil(() => harness.hostCalls.length === 1, 'armed fixture host rewrite did not start');
  assertEqual(harness.runtime.postProcessPending(), false, 'starting consumes the pending arm');
  assertEqual(harness.runtime.postProcessRunning(), true, 'started operation reports running');
  harness.runtime.cancelPostProcess('test-stop');
  assertEqual(harness.hostCalls[0].signal.aborted, true, 'Stop aborts the active native quiet-generation signal');
  hostGate.resolve('must not commit');
  const result = await running;
  assertEqual(result.reason, 'canceled', 'active host rewrite cancels fail-soft');
  assertEqual(harness.commitCalls.length, 0, 'canceled host rewrite cannot commit');
  const serialized = JSON.stringify(events);
  assert(!serialized.includes('must not commit'), 'activity omits canceled candidate prose');
  assert(events.some((event) => event.phase === 'postProcessStarted'), 'activity records Post-process start');
  assert(events.some((event) => event.phase === 'settled' && event.outcome === 'canceled'), 'activity records neutral cancellation');
});

let passed = 0;
for (const entry of cases) {
  try {
    await entry.run();
    passed += 1;
  } catch (error) {
    error.message = `${entry.name}: ${error.message}`;
    throw error;
  }
}

assertEqual(passed, 23, 'the complete 23-case state-machine matrix ran');
console.log('[pass] post-process runtime (23 cases)');
