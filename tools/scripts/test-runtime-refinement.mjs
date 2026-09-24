import assert from 'node:assert/strict';
import { createActivityReporter } from '../../src/activity.mjs';
import { createRecursionRuntime } from '../../src/runtime.mjs';
import { createSettingsStore } from '../../src/settings.mjs';
import { createMemoryStorageAdapter, createStorageRepository } from '../../src/storage.mjs';

const ORIGINAL = 'Track the archive as sealed and avoid assuming how its seal works.';
const REVISED = 'Keep the archive sealed; its lock mechanism remains unknown until observed.';
const AUTHORED = 'Track Mara\'s current observations without treating her claims as world truth.';
const APPLICATION = 'Keep Mara beside the archive and distinguish her answer from independently observed facts.';
const PLAIN = 'Preserve the player\'s control over their own actions.';
const initialSnapshot = () => ({
  chatId: 'refinement-runtime', chatKey: 'refinement-runtime', sceneKey: 'archive',
  sceneFingerprint: 'archive-scene', turnFingerprint: 'archive-turn', sourceRevisionHash: 'archive-source', latestMesId: 2,
  messages: [
    { mesid: 1, role: 'assistant', text: 'Mara stands beside a sealed archive.', visible: true },
    { mesid: 2, role: 'user', text: 'What do you remember?', visible: true }
  ]
});
function deckSettings({ authored = false, refinement = true } = {}) {
  const cards = Object.fromEntries([
    { id: 'facet-a', name: 'Evidence', builtinFamily: 'Realism', builtinRoleId: 'realismCard', promptText: 'Separate claims from established facts.' },
    { id: 'facet-b', name: 'Assumptions', builtinFamily: 'Realism', builtinRoleId: 'realismCard', promptText: 'Keep unresolved assumptions uncertain.' },
    ...(authored ? [{ id: 'authored', name: 'Mara evidence', promptText: AUTHORED }] : []),
    { id: 'plain', name: 'Player control', promptText: PLAIN }
  ].map(card => [card.id, { ...card, categoryId: 'general', kind: card.builtinFamily ? 'generated' : 'authored',
    selectionState: card.id === 'plain' ? 'priority' : !refinement ? 'active' : 'refinement' }]));
  return { activeDeckId: 'test', customDecks: { test: { id: 'test', name: 'Runtime refinement',
    categories: { general: { id: 'general', name: 'General' } }, categoryOrder: ['general'], cards,
    cardOrderByCategory: { general: Object.keys(cards) } } } };
}
function createHarness({ pipelineMode = 'segmented', authored = false, refinement = true, rejectTwice = false, providerFailure = false, draftGate = null, mode = 'auto', maxCards = 4, acceptUnchanged = false } = {}) {
  const calls = [];
  const installed = [];
  let currentSnapshot = initialSnapshot();
  let draftBlocked = false;
  const settingsStore = createSettingsStore({ root: {} });
  settingsStore.update({ pipelineMode, mode, modelAttemptsPerStep: 2, reasoningLevel: 'low', reasonerUse: 'off', minCards: 1, maxCards,
    preProcessDecks: deckSettings({ authored, refinement }) });
  for (const lane of ['utility', 'reasoner']) settingsStore.updateProviderConfig(lane, { connectionProfileId: `${lane}-profile` });
  const storage = createStorageRepository({ storage: createMemoryStorageAdapter() });
  const provider = { async generate(roleId, request) {
    calls.push({ roleId, request });
    if (roleId === 'utilityArbiter') return { ok: true, data: {
      schema: 'recursion.utilityArbiter.v1', snapshotHash: request.snapshotHash, action: 'compose-brief', sceneStatus: 'same-scene',
      promptFootprint: 'normal', cardJobs: mode === 'manual' ? [] : [{ family: 'Realism', role: 'realismCard', reason: 'Check the archive claim.' }],
      budgets: { targetBriefTokens: 500, maxCards }, reasonerDecision: { mode: 'skip', reason: 'Unit test', signals: [] }, diagnostics: []
    } };
    if (roleId === 'fusedCardBundle') return { ok: true, data: { items: request.requestedCards.map(card => ({
      family: card.family, promptText: ORIGINAL, evidenceRefs: ['message:1'], coveredSourceCardIds: card.sourceCardIds
    })) } };
    if (roleId === 'realismCard') return { ok: true, data: { promptText: ORIGINAL, evidenceRefs: ['message:1'] } };
    if (roleId === 'cardRefinementReview') {
      if (providerFailure) return { ok: false, error: { code: 'RECURSION_PROVIDER_REFUSAL', message: 'Provider refused refinement.', retryable: false } };
      return { ok: true, data: { schema: request.responseSchema, snapshotHash: request.snapshotHash,
        items: request.refinementTargetIds.map(targetId => {
          const revise = !acceptUnchanged && targetId === 'facet-a' && (request.phase === 'review' || rejectTwice);
          return { targetId, verdict: revise ? 'revise' : 'accept', assessment: {
            status: revise ? 'needs-work' : 'satisfied', summary: revise ? 'Audit assessment: distinguish the seal from its unknown mechanism.' : 'Audit assessment: the selected result keeps the seal established and the mechanism uncertain.',
            evidenceRefs: ['message:1'], supportingCardIds: [request.targets.find(target => target.id === targetId).cardId]
          }, findings: revise
            ? [{ message: 'A sealed archive does not establish a lock mechanism.', evidenceRefs: ['message:1'] }] : [] };
        })
      } };
    }
    if (roleId === 'cardRefinementDraft') {
      if (draftGate && !draftBlocked && request.phase === 'revise') { draftBlocked = true; await draftGate.promise; }
      return { ok: true, data: { schema: request.responseSchema, snapshotHash: request.snapshotHash,
        items: request.refinementCardIds.map(cardId => ({ cardId, promptText: cardId === 'authored' ? APPLICATION : REVISED, evidenceRefs: ['message:1'] })) } };
    }
    if (roleId === 'guidanceComposer') return { ok: true, data: {
      schema: 'recursion.guidanceComposer.v1', snapshotHash: request.snapshotHash, guidanceText: 'Keep the next exchange grounded in visible evidence.',
      sourceCardIds: request.guidanceCardIds, guardrailCardIds: [], omittedCardIds: [], diagnostics: []
    } };
    throw new Error(`Unexpected role ${roleId}`);
  } };
  const host = {
    providerProfiles: { list: () => ['utility', 'reasoner'].map(lane => ({ id: `${lane}-profile`, name: lane, completionMode: 'chat' })) },
    snapshot: async () => structuredClone(currentSnapshot),
    prompt: { install: async packet => { installed.push(packet); return { ok: true, installed: true }; }, clear: async () => ({ ok: true, cleared: true }) },
    messages: {}, generation: { start: async () => ({ ok: true, started: true }), stop: async () => ({ ok: true, stopped: true, eventEmitted: false }) }
  };
  const runtime = createRecursionRuntime({ host, settingsStore, storage, generationRouter: provider, activity: createActivityReporter() });
  return { runtime, calls, installed, storage, settingsStore, setSnapshot: value => { currentSnapshot = value; }, setRejectTwice: value => { rejectTwice = value; } };
}
const prepare = harness => harness.runtime.prepareForGeneration({ userMessage: { mesid: 2, text: 'What do you remember?' }, hostGeneration: true, generationType: 'normal' });
const phaseCalls = harness => harness.calls.filter(call => call.roleId.startsWith('cardRefinement'));

for (const pipelineMode of ['segmented', 'fused']) {
  const harness = createHarness({ pipelineMode });
  const result = await prepare(harness);
  assert.equal(result.ok, true, `${pipelineMode} refinement completes: ${JSON.stringify(result.error)}`);
  assert.deepEqual(phaseCalls(harness).map(call => call.request.phase), ['review', 'revise', 'verify']);
  const [review, revise, verify] = phaseCalls(harness).map(call => call.request);
  assert.equal(review.refinementTargetIds.length, 2, 'both marked facets receive a verdict');
  assert.equal(revise.refinementCardIds.length, 1, 'one runtime family is revised once');
  assert.equal(verify.refinementTargetIds.length, 2, 'all marked family facets get the second review');
  assert.ok(revise.prompt.includes('does not establish a lock mechanism'), 'revision includes actionable findings');
  const guidance = harness.calls.find(call => call.roleId === 'guidanceComposer').request;
  assert.ok(guidance.prompt.includes(REVISED), 'Guidance receives the accepted revision');
  assert.ok(!guidance.prompt.includes(ORIGINAL), 'Guidance does not receive the superseded result');
  assert.ok(JSON.stringify(harness.installed[0]).includes(REVISED), 'accepted result reaches narration packet');
  assert.ok(!JSON.stringify(harness.installed[0]).includes(ORIGINAL), 'superseded draft stays out of narration packet');
  assert.ok(!guidance.prompt.includes('Audit assessment:'), 'assessments stay out of Guidance input');
  assert.ok(!JSON.stringify(harness.installed[0]).includes('Audit assessment:'), 'assessments stay out of narration packets');
  const hand = harness.runtime.view().lastHand;
  assert.equal(hand.cards.filter(card => card.family === 'Realism').length, 1);
  assert.equal(hand.cards.find(card => card.id === 'plain').promptText, PLAIN, 'unmarked authored instruction stays unchanged');
  assert.deepEqual(hand.metadata.refinement.targets.map(target => target.revisionCount), [1, 1]);
  assert.ok(hand.metadata.refinement.targets.every(target => target.assessment.status === 'satisfied'), 'final accepted assessments are visible to the Viewer');
  const manifest = await harness.storage.loadPipelineRun('refinement-runtime');
  assert.equal(manifest.stageRecords['preprocess.refinement.hand'].state, 'completed');
  assert.ok(!JSON.stringify(manifest.stageRecords).includes('Audit assessment:'), 'compact execution records exclude assessment prose');
}

for (const pipelineMode of ['segmented', 'fused']) {
  const harness = createHarness({ pipelineMode, acceptUnchanged: true });
  assert.equal((await prepare(harness)).ok, true);
  assert.deepEqual(phaseCalls(harness).map(call => call.request.phase), ['review'], 'supported acceptance adds no model call');
  assert.ok(harness.runtime.view().lastHand.metadata.refinement.targets.every(target =>
    target.outcome === 'unchanged' && target.assessment.summary.startsWith('Audit assessment:')),
  'both modes retain inspectable unchanged assessments');
}

for (const pipelineMode of ['segmented', 'fused']) {
  const harness = createHarness({ pipelineMode, authored: true });
  assert.equal((await prepare(harness)).ok, true);
  assert.deepEqual(phaseCalls(harness).map(call => call.request.phase), ['prepare', 'review', 'revise', 'verify']);
  assert.deepEqual(phaseCalls(harness)[0].request.refinementCardIds, ['authored']);
  const card = harness.runtime.view().lastHand.cards.find(card => card.id === 'authored');
  assert.ok(card.promptText.startsWith(AUTHORED));
  assert.ok(card.promptText.includes(APPLICATION));
  assert.equal(harness.settingsStore.get().preProcessDecks.customDecks.test.cards.authored.promptText, AUTHORED);
  assert.ok(JSON.stringify(harness.installed[0]).includes(APPLICATION));
}

for (const failureMode of ['unresolved', 'provider']) {
  const harness = createHarness({ rejectTwice: failureMode === 'unresolved', providerFailure: failureMode === 'provider' });
  const result = await prepare(harness);
  assert.equal(result.ok, false);
  assert.equal(result.continuePrimaryGeneration, false, `${failureMode} blocks narration`);
  assert.equal(harness.installed.length, 0);
  assert.equal(harness.calls.some(call => call.roleId === 'guidanceComposer'), false);
  const manifest = await harness.storage.loadPipelineRun('refinement-runtime');
  const failed = manifest.stageRecords[`preprocess.refinement.${failureMode === 'unresolved' ? 'hand' : 'review'}`];
  assert.equal(failed.state, 'failed');
  assert.equal(failed.failure.code, failureMode === 'unresolved' ? 'RECURSION_REFINEMENT_UNRESOLVED' : 'RECURSION_PROVIDER_REFUSAL', 'failure classification is preserved');
  assert.equal(phaseCalls(harness).filter(call => call.request.phase === 'review').length, 1, 'semantic failure never repeats first review');
  if (failureMode === 'unresolved') {
    assert.equal(phaseCalls(harness).filter(call => call.request.phase === 'verify').length, 1, 'second semantic rejection is terminal');
    harness.setRejectTwice(false);
    const initialCardCalls = harness.calls.filter(call => call.roleId === 'realismCard').length;
    const retried = await harness.runtime.retryStage({ operationId: manifest.operationId, stageId: 'preprocess.refinement.hand' });
    assert.equal((retried.execution || retried).state, 'completed', 'explicit Retry reruns semantic review and recovers');
    assert.equal(phaseCalls(harness).filter(call => call.request.phase === 'review').length, 2, 'semantic Retry starts a new first review');
    assert.equal(harness.calls.filter(call => call.roleId === 'realismCard').length, initialCardCalls, 'semantic Retry preserves accepted initial generation');
    assert.equal(harness.installed.length, 1);
  }
}

{
  const harness = createHarness({ refinement: false });
  assert.equal((await prepare(harness)).ok, true);
  assert.equal(phaseCalls(harness).length, 0, 'no marked cards means no extra model work');
  const manifest = await harness.storage.loadPipelineRun('refinement-runtime');
  assert.equal(Object.keys(manifest.stageRecords).some(id => id.startsWith('preprocess.refinement')), false);
}

{
  const harness = createHarness();
  assert.equal((await prepare(harness)).ok, true);
  const firstCount = harness.calls.length;
  const assistantSnapshot = { ...initialSnapshot(), latestMesId: 3, messages: [...initialSnapshot().messages,
    { mesid: 3, role: 'assistant', text: 'Mara answers beside the sealed archive.', visible: true }] };
  harness.setSnapshot(assistantSnapshot);
  await harness.runtime.handleLatestAssistantSwipeRetry({ messageId: 3 });
  const swipe = await harness.runtime.prepareForGeneration({ userMessage: null, hostGeneration: true, generationType: 'swipe' });
  assert.equal(swipe.ok, true, 'matching swipe reuses accepted refinement');
  assert.equal(harness.calls.length, firstCount, 'matching swipe performs no additional review');
  const decks = structuredClone(harness.settingsStore.get().preProcessDecks);
  decks.customDecks.test.cards['facet-a'].promptText = 'Separate claims from observations and preserve newly raised questions.';
  await harness.runtime.updateSettings({ preProcessDecks: decks });
  await harness.runtime.handleLatestAssistantSwipeRetry({ messageId: 3 });
  const changed = await harness.runtime.prepareForGeneration({ userMessage: null, hostGeneration: true, generationType: 'swipe' });
  assert.equal(changed.ok, true, 'changed authored deck text is prepared afresh');
  assert.equal(phaseCalls(harness).filter(call => call.request.phase === 'review').length, 2, 'deck instruction edit invalidates accepted review');
  assert.ok(phaseCalls(harness).findLast(call => call.request.phase === 'review').request.prompt.includes(decks.customDecks.test.cards['facet-a'].promptText));
  const activeDecks = structuredClone(decks);
  for (const id of ['facet-a', 'facet-b']) activeDecks.customDecks.test.cards[id].selectionState = 'active';
  await harness.runtime.updateSettings({ preProcessDecks: activeDecks });
  await harness.runtime.handleLatestAssistantSwipeRetry({ messageId: 3 });
  const unmarked = await harness.runtime.prepareForGeneration({ userMessage: null, hostGeneration: true, generationType: 'swipe' });
  assert.equal(unmarked.ok, true, 'turning Refinement off still prepares the active cards');
  assert.equal(phaseCalls(harness).filter(call => call.request.phase === 'review').length, 2, 'unmarked state has no refinement call');
  assert.equal(harness.runtime.view().lastHand.metadata.refinement, undefined, 'state toggle invalidates old accepted metadata');
  await harness.runtime.updateSettings({ preProcessDecks: decks });
  await harness.runtime.handleLatestAssistantSwipeRetry({ messageId: 3 });
  const remarked = await harness.runtime.prepareForGeneration({ userMessage: null, hostGeneration: true, generationType: 'swipe' });
  assert.equal(remarked.ok, true);
  assert.equal(phaseCalls(harness).filter(call => call.request.phase === 'review').length, 3, 'turning Refinement on requires a fresh review');
  const nextSnapshot = { ...assistantSnapshot, latestMesId: 4, sourceRevisionHash: 'archive-next-source', turnFingerprint: 'archive-next-turn',
    messages: [...assistantSnapshot.messages, { mesid: 4, role: 'user', text: 'What do you remember?', visible: true }] };
  harness.setSnapshot(nextSnapshot);
  const nextTurn = await harness.runtime.prepareForGeneration({ userMessage: { mesid: 4, text: 'What do you remember?' }, hostGeneration: true, generationType: 'normal' });
  assert.equal(nextTurn.ok, true);
  assert.equal(phaseCalls(harness).filter(call => call.request.phase === 'review').length, 4, 'fresh user turn requires fresh semantic review');
}

{
  let releaseDraft;
  const gate = { promise: new Promise(resolve => { releaseDraft = resolve; }) };
  const harness = createHarness({ draftGate: gate });
  const preparing = prepare(harness);
  for (let attempt = 0; attempt < 200 && !phaseCalls(harness).some(call => call.request.phase === 'revise'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.ok(phaseCalls(harness).some(call => call.request.phase === 'revise'), 'revision reached cancellation boundary');
  await harness.runtime.stopGeneration({ source: 'recursion-progress-row' });
  const paused = await harness.storage.loadPipelineRun('refinement-runtime');
  assert.equal(paused.state, 'paused');
  assert.equal(paused.stageRecords['preprocess.refinement.review'].state, 'completed', 'completed review remains checkpointed');
  assert.equal(harness.installed.length, 0, 'stopped revision never installs a prompt');
  assert.equal(phaseCalls(harness).find(call => call.request.phase === 'revise').request.signal.aborted, true);
  releaseDraft();
  await preparing;
  const resume = await harness.runtime.resumeOperation({ operationId: paused.operationId });
  assert.equal(resume.started, true);
  const resumed = await prepare(harness);
  assert.equal(resumed.ok, true, 'native generation resumes pending revision');
  assert.equal(phaseCalls(harness).filter(call => call.request.phase === 'review').length, 1, 'Resume reuses completed semantic review');
  assert.equal(phaseCalls(harness).filter(call => call.request.phase === 'revise').length, 2, 'only interrupted revision gets a new call');
  assert.equal(phaseCalls(harness).filter(call => call.request.phase === 'verify').length, 1);
  assert.equal(harness.installed.length, 1);
}

for (const pipelineMode of ['segmented', 'fused']) {
  const harness = createHarness({ pipelineMode, mode: 'manual', maxCards: 1, authored: true });
  assert.equal((await prepare(harness)).ok, true, 'Manual Refinement succeeds despite requested one-card limit');
  assert.ok(harness.calls.some(call => ['realismCard', 'fusedCardBundle'].includes(call.roleId)), 'Manual generates marked cards despite empty Arbiter selection');
  const hand = harness.runtime.view().lastHand;
  assert.equal(hand.cards[0].family, 'Realism', 'first marked generated family preserves deck order');
  assert.equal(hand.cards[1].id, 'authored', 'authored Refinement follows generated family in deck order');
  assert.ok(hand.cards.length >= 2, 'mandatory Refinement exceeds requested capacity');
  assert.deepEqual(hand.metadata.refinement.targets.map(target => target.targetId), ['facet-a', 'facet-b', 'authored']);
}

console.log('[pass] runtime refinement integration');
