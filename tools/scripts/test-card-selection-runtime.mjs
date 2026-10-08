import assert from 'node:assert/strict';
import { reconcileAutoPriorityPlan, cardSelectionSettingsForTurn, cardSelectionSettingsForPlan, preparedGenerationSettingsSignature } from '../../src/runtime.mjs';
import { createDefaultCardDeck, activeCardDeckSourceCards, getActiveCardDeck } from '../../src/pre-process-decks.mjs';
import { buildCardRequests, buildFusedCardBundleRequest } from '../../src/cards.mjs';
import { normalizeSettings } from '../../src/settings.mjs';
const deck=createDefaultCardDeck();
deck.id='test-selection'; deck.name='Selection test'; deck.bundled=false; deck.readonly=false;
for(const card of Object.values(deck.cards)) card.selectionState='off';
let scenes=Object.values(deck.cards).filter(c=>c.builtinFamily==='Scene Frame');
scenes[0].selectionState='priority'; scenes[1].selectionState='active'; scenes[2].selectionState='active';
scenes[0].promptText='PRIORITY_SENTINEL'; scenes[1].promptText='COOLED_SENTINEL'; scenes[2].promptText='ELIGIBLE_SENTINEL';
const environment=Object.values(deck.cards).find(c=>c.builtinFamily==='Environment'); environment.selectionState='active';
const settings=normalizeSettings({mode:'auto',cardsPerTurn: 2,cardSelection:{variety:'off',cooldownTurns:1},preProcessDecks:{activeDeckId:deck.id,customDecks:{[deck.id]:deck}}});
scenes=Object.values(getActiveCardDeck(settings).cards).filter(c=>c.builtinFamily==='Scene Frame');
const history=[{deckId:deck.id,cards:scenes.slice(0,2).map(c=>({cardId:c.id}))}];
const filtered=cardSelectionSettingsForTurn(settings,{cardSelectionHistory:history});
assert.deepEqual(activeCardDeckSourceCards(filtered)['Scene Frame'].map(c=>c.id),[scenes[0].id,scenes[2].id]);
assert.equal(getActiveCardDeck(settings).cards[scenes[1].id].selectionState,'active','cooldown never mutates saved state');
const plan=reconcileAutoPriorityPlan({action:'refresh-cards',budgets:{maxCards:2},cardJobs:[{family:'Scene Frame',sourceCardIds:[scenes[1].id],reason:'old need'},{family:'Environment',reason:'exit is blocked'}]},filtered,{seed:'turn',history});
assert.deepEqual(plan.cardJobs.map(c=>c.family),['Scene Frame','Environment']);
const generatedSettings=cardSelectionSettingsForPlan(filtered,plan);
const context={snapshot:{messages:[]},sourceCardsByFamily:activeCardDeckSourceCards(generatedSettings)};
const prompts=buildCardRequests(plan,context).map(r=>r.prompt).join('\n');
assert(!prompts.includes('COOLED_SENTINEL')); assert(prompts.includes('PRIORITY_SENTINEL'));
assert(!buildFusedCardBundleRequest(plan,context).prompt.includes('COOLED_SENTINEL'));
const manual=cardSelectionSettingsForTurn({...settings,mode:'manual'},{cardSelectionHistory:history});
assert.equal(activeCardDeckSourceCards(manual)['Scene Frame'].length,3);
assert.notDeepEqual(preparedGenerationSettingsSignature(settings),preparedGenerationSettingsSignature({...settings,cardSelection:{variety:'high',cooldownTurns:1}}));
const emptySettings=cardSelectionSettingsForTurn({...settings,preProcessDecks:{...settings.preProcessDecks,customDecks:{[deck.id]:{...deck,cards:Object.fromEntries(Object.values(deck.cards).map(c=>[c.id,{...c,selectionState:c.selectionState==='priority'?'active':c.selectionState}]))}}}},{cardSelectionHistory:[{deckId:deck.id,cards:Object.values(getActiveCardDeck(settings).cards).map(c=>({cardId:c.id}))}]});
const empty=reconcileAutoPriorityPlan({action:'refresh-cards',budgets:{maxCards:2},cardJobs:[{family:'Scene Frame'}]},emptySettings,{seed:'empty'});
assert.equal(empty.cardJobs.length,0); assert.equal(empty.action,'skip');
const refinementDeck=structuredClone(getActiveCardDeck(settings));
refinementDeck.cards[scenes[0].id].selectionState='refinement';
const refinementSettings={...settings,preProcessDecks:{...settings.preProcessDecks,customDecks:{[deck.id]:refinementDeck}}};
const refinementFiltered=cardSelectionSettingsForTurn(refinementSettings,{cardSelectionHistory:history});
const refinementPlan=reconcileAutoPriorityPlan({action:'skip',cardJobs:[],budgets:{maxCards:0}},refinementFiltered);
assert(refinementPlan.selection.mandatoryCardIds.includes(scenes[0].id),'Refinement remains mandatory through cooldown');
assert(activeCardDeckSourceCards(cardSelectionSettingsForPlan(refinementFiltered,refinementPlan))['Scene Frame'].some(c=>c.id===scenes[0].id),'Refinement survives final source mask');
console.log('[pass] card selection runtime contracts');

// Edits outside the bounded provider band still invalidate selection eligibility.
const { createTurnIdentity } = await import('../../src/runtime/turn-scope.mjs');
const identityInput={snapshot:{chatKey:'branch',messages:[{mesid:10,role:'user',text:'unchanged recent input'}],cardSelectionSourcePrefixHash:'old-prefix'}};
const oldIdentity=await createTurnIdentity(identityInput);
const editedIdentity=await createTurnIdentity({...identityInput,snapshot:{...identityInput.snapshot,cardSelectionSourcePrefixHash:'edited-prefix'}});
assert.notEqual(oldIdentity.turnKeyHash,editedIdentity.turnKeyHash,'full branch lineage must invalidate prepared/resumed selection');

// Real host metadata + runtime + generation integration across successive turns.
const { createRecursionRuntime } = await import('../../src/runtime.mjs');
const { createSettingsStore } = await import('../../src/settings.mjs');
const { createMemoryStorageAdapter, createStorageRepository } = await import('../../src/storage.mjs');
const { createSillyTavernHost } = await import('../../src/hosts/sillytavern/host.mjs');
const { CARD_CATALOG } = await import('../../src/cards.mjs');
for (const pipelineMode of ['segmented','fused']) {
  const localDeck=createDefaultCardDeck(); localDeck.id='successive';localDeck.name='Successive';localDeck.bundled=false;localDeck.readonly=false;
  for(const card of Object.values(localDeck.cards))card.selectionState='off';
  const sources=Object.values(localDeck.cards).filter(c=>c.builtinFamily==='Scene Frame');
  sources[0].selectionState='active';sources[0].promptText='FIRST_ONLY_INSTRUCTIONS';
  sources[1].selectionState='active';sources[1].promptText='SECOND_ONLY_INSTRUCTIONS';
  localDeck.cards.authored={id:'authored',name:'Authored',categoryId:localDeck.categoryOrder[0],promptText:'Authored distinct guidance.',selectionState:'active',kind:'authored'};
  localDeck.cardOrderByCategory[localDeck.categoryOrder[0]].push('authored');
  const store=createSettingsStore({root:{recursion:{mode:'auto',pipelineMode,reasoningLevel:'low',cardsPerTurn: 1,cardSelection:{variety:'off',cooldownTurns:2},preProcessDecks:{activeDeckId:localDeck.id,customDecks:{[localDeck.id]:localDeck}},providers:{utility:{connectionProfileId:'u'},reasoner:{connectionProfileId:'r'}}}}});
  const normalizedSources=Object.values(getActiveCardDeck(store.get()).cards).filter(c=>c.builtinFamily==='Scene Frame');
  const chat={chatId:`selection-${pipelineMode}`,chat:[{is_user:true,mes:'What changed?'},
    {is_user:false,mes:'Initial narration remains in the model source.'}],async saveChat(){}};
  const realHost=createSillyTavernHost({contextFactory:()=>chat,settingsRoot:{}});
  const requests=[];let turn=0;
  const router={async generate(roleId,request){
    requests.push({roleId,request,turn});
    if(roleId==='utilityArbiter') return {ok:true,data:{schema:'recursion.utilityArbiter.v1',snapshotHash:request.snapshotHash,action:'refresh-cards',budgets:{maxCards:turn===2?2:1},cardJobs:turn===2?[{cardId:'authored',reason:'A distinct authored reminder'}]:[{family:'Scene Frame',sourceCardIds:[normalizedSources[turn].id],reason:turn?'React to the new answer':'Clarify the current question',coverageKey:'current-exchange'}]}};
    if(roleId==='guidanceComposer')return {ok:true,data:{schema:'recursion.guidanceComposer.v1',snapshotHash:request.snapshotHash,guidanceText:'Respond to the current request.'}};
    if(roleId==='fusedCardBundle')return {ok:true,data:{items:request.requestedCards.map(c=>({family:c.family,promptText:'Current exchange guidance.',evidenceRefs:['message:0'],coveredSourceCardIds:c.sourceCardIds}))}};
    const catalog=CARD_CATALOG.find(c=>c.role===roleId);
    return {ok:true,data:{schema:'recursion.card.v1',snapshotHash:request.snapshotHash,role:roleId,family:catalog.family,items:[{promptText:'Current exchange guidance.',evidenceRefs:['message:0']}]}};
  }};
  const installedPackets = [];
  let storage = createStorageRepository(createMemoryStorageAdapter());
  const newRuntime = () => createRecursionRuntime({host:{...realHost,providerProfiles:{list:()=>[{id:'u',completionMode:'chat'},{id:'r',completionMode:'chat'}]},prompt:{install:async packet=>{ installedPackets.push(structuredClone(packet)); return {ok:true,installed:true}; },clear:async()=>({ok:true})}},settingsStore:store,storage,generationRouter:router});
  let runtime = newRuntime();
  const continued = await runtime.prepareForGeneration({hostGeneration:true,generationType:'continue'});
  assert.equal(continued.ok,true);
  assert(requests.some(({request})=>request.prompt.includes('Initial narration remains in the model source.')),
    'Continue preserves the prior narration in actual model requests');
  chat.chat[1].mes += ' Continued narration.';
  await runtime.handleHostGenerationEnded({eventName:'generation_ended'});
  assert.equal((await realHost.snapshot()).cardSelectionHistory[0].cards[0]?.cardId,normalizedSources[0].id,
    'real runtime persists Continue through the host-owned basis');
  await runtime.prepareForGeneration({hostGeneration:true,generationType:'continue'});
  chat.chat[0].mes = 'Changed prior branch';
  chat.chat[1].mes += ' Late continuation';
  assert.equal((await runtime.handleHostGenerationEnded({eventName:'generation_ended'})).ok,true,
    'a rejected optional receipt does not fail completed narration');
  let rejected = (await storage.loadRunJournal(chat.chatId)).entries.findLast(entry=>entry.event==='card-selection.history-not-saved');
  assert.equal(rejected.details.reason,'card-selection-prefix-changed');
  assert.notEqual(rejected.details.expectedPrefixHash,rejected.details.observedPrefixHash);
  chat.chat[0].mes = 'What changed?';
  await runtime.prepareForGeneration({hostGeneration:true,generationType:'continue'});
  chat.chat[1].mes += ' Narration with unavailable storage';
  chat.saveChat = async () => {throw new Error('PRIVATE_STORY_CANARY');};
  assert.equal((await runtime.handleHostGenerationEnded({eventName:'generation_ended'})).ok,true);
  rejected = (await storage.loadRunJournal(chat.chatId)).entries.findLast(entry=>entry.event==='card-selection.history-not-saved');
  assert.equal(rejected.details.reason,'history-save-failed');
  assert(!JSON.stringify(rejected).includes('PRIVATE_STORY_CANARY'));
  chat.saveChat = async () => {};
  const captureBasis = realHost.messages.cardSelectionReceiptBasis;
  realHost.messages.cardSelectionReceiptBasis = async () => null;
  assert.equal((await runtime.prepareForGeneration({hostGeneration:true,generationType:'continue'})).ok,true,
    'unavailable receipt basis leaves successful preparation usable');
  rejected = (await storage.loadRunJournal(chat.chatId)).entries.findLast(entry=>entry.event==='card-selection.history-not-saved');
  assert.equal(rejected.details.reason,'card-selection-basis-unavailable','unavailable capture is explained without guessing a prefix');
  realHost.messages.cardSelectionReceiptBasis = captureBasis;
  await runtime.dispose();
  chat.chat.splice(1); // A fresh synthetic branch for the Normal/Swipe cache checks.
  storage = createStorageRepository(createMemoryStorageAdapter());
  requests.length = 0; installedPackets.length = 0;
  runtime = newRuntime();
  for(turn=0;turn<3;turn++){
    if(turn===2)store.update({cardsPerTurn: 2});
    const prepared=await runtime.prepareForGeneration({hostGeneration:true,userMessage:chat.chat.at(-1).mes});
    assert.equal(prepared.ok,true,`${pipelineMode} turn ${turn} prepares`);
    const recordedConfiguration=(await storage.loadRunJournal(chat.chatId)).operationSummaries.at(-1).configuration;
    assert.equal(recordedConfiguration.cardsPerTurn,store.get().cardsPerTurn,'retain the target used by this operation');
    assert.equal(recordedConfiguration.reasonerUse,'off','retain actual Low routing, not current export settings');
    assert.equal(prepared.hand.cards.length,1,`${pipelineMode} exactly selected card, no fabricated fallback`);
    if(turn<2)assert.deepEqual(prepared.hand.cards[0].sourceCardIds,[normalizedSources[turn].id]);
    else {
      assert.equal(prepared.hand.cards[0].id,'authored');
      assert(!prepared.hand.metadata.selection.shortfallReasons.includes('planned-card-missing'),'authored eligibility shortage is not missing planned work');
    }
    const current=requests.filter(r=>r.turn===turn);
    if(turn===1){
      const cardPrompts=current.filter(r=>r.roleId.endsWith('Card')||r.roleId==='fusedCardBundle').map(r=>r.request.prompt).join('\n');
      assert(!cardPrompts.includes('FIRST_ONLY_INSTRUCTIONS'),'cooled sibling excluded in actual generator');
      assert(cardPrompts.includes('SECOND_ONLY_INSTRUCTIONS'),'eligible sibling remains available');
    }
    chat.chat.push({is_user:false,mes:`Completed response ${turn}`});
    await runtime.handleHostGenerationEnded({eventName:'generation_ended'});
    const history=(await realHost.snapshot()).cardSelectionHistory;
    assert.equal(history.at(-1).cards.length,1,'real runtime persists Continue and Normal usage through the host-owned basis');
    if(turn<2)assert.equal(history.at(-1).cards[0].cardId,normalizedSources[turn].id);
    if(turn===0){
      const callCount=requests.length;
      const originalPacket = structuredClone(installedPackets.at(-1));
      const originalOperation = (await storage.loadPipelineRun(chat.chatId)).operationId;
      for (const response of ['Completed response 0', 'Long response. '.repeat(10000), '', 'Edited alternate response']) {
        chat.chat.at(-1).mes = response;
        await runtime.dispose();
        runtime = newRuntime();
        const restored = await runtime.restoreExecutionState();
        assert.equal(restored.state, 'completed', 'reload after a response or empty swipe placeholder preserves cached preparation');
        assert.equal(restored.operationId, originalOperation, 'restoration retains the original operation');
        const installsBeforeSwipe = installedPackets.length;
        const swipe=await runtime.prepareForGeneration({hostGeneration:true,generationType:'swipe'});
        assert.equal(swipe.recursionPromptInstalled,true,'same-turn swipe reinstalls its packet');
        assert.equal(installedPackets.length, installsBeforeSwipe + 1, 'swipe installs exactly once');
        assert.deepEqual(installedPackets.at(-1), originalPacket, 'swipe injects the exact original packet');
        assert.equal(requests.length,callCount,'restoration and swipe do not reroll or call any Recursion model');
      }
      const message=chat.chat.at(-1);
      message.swipes=[message.mes,'Alternate completed response'];
      message.swipe_info=[{extra:structuredClone(message.extra)},{extra:{}}];
      message.swipe_id=1;message.mes=message.swipes[1];
      await runtime.handleHostGenerationEnded({eventName:'generation_ended'});
      assert.deepEqual((await realHost.snapshot()).cardSelectionHistory[0].cards,[],
        'an active swipe change after capture cannot redirect the late receipt');
      const rejection=(await storage.loadRunJournal(chat.chatId)).entries.findLast(entry=>entry.event==='card-selection.history-not-saved');
      assert.equal(rejection.details.reason,'card-selection-target-changed');
      assert.equal(rejection.details.expectedTargetMessageId,1);
      assert.equal(rejection.details.observedTargetMessageId,1,'numeric target details help distinguish swipe changes');
      await runtime.prepareForGeneration({hostGeneration:true,generationType:'swipe'});
      await runtime.handleHostGenerationEnded({eventName:'generation_ended'});
      const swipedHistory=(await realHost.snapshot()).cardSelectionHistory;
      assert.equal(swipedHistory.length,1,'same response swipe never ages cooldown');
      assert.equal(swipedHistory[0].cards[0].cardId,normalizedSources[0].id,'swipe retains exact prepared hand provenance');
    }
    if(turn===2){
      await runtime.prepareForGeneration({hostGeneration:true,generationType:'swipe'});
      let releaseSave;
      let enteredSave;
      const saveStarted = new Promise(resolve=>{enteredSave=resolve;});
      const blockedSave = new Promise(resolve=>{releaseSave=resolve;});
      let saveCalls = 0;
      chat.saveChat = async () => {saveCalls++;enteredSave();await blockedSave;};
      const completionA = runtime.handleHostGenerationEnded({eventName:'generation_ended'});
      const completionB = runtime.handleHostGenerationEnded({eventName:'generation_ended'});
      await saveStarted;
      let preparedNext = false;
      const next = runtime.prepareForGeneration({hostGeneration:true,generationType:'swipe'}).then(value=>{
        preparedNext=true;return value;
      });
      await Promise.resolve();
      assert.equal(preparedNext,false,'the next preparation waits for the in-flight receipt commit');
      releaseSave();
      await Promise.all([completionA,completionB,next]);
      assert.equal(saveCalls,1,'concurrent native completion records once');
      chat.saveChat = async () => {};
      chat.streamingProcessor={messageId:chat.chat.length-1,isStopped:true};
      chat.chat.at(-1).mes += ' Partial continuation';
      await runtime.handleHostGenerationStopped({eventName:'generation_stopped'});
      assert.equal((await realHost.snapshot()).cardSelectionHistory.at(-1)?.messageId,3,
        'stopped active output does not age the history window');
      chat.streamingProcessor=null;
      assert.equal((await realHost.snapshot()).cardSelectionHistory.at(-1)?.messageId,3,
        'the runtime passes the binding to the persisted incomplete marker');
    }
    chat.chat.push({is_user:true,mes:`Next request ${turn}`});
  }
  chat.chat.pop(); // Leave the completed assistant response as the latest row.
  chat.chat[0].mes = 'Changed earlier source input';
  const callsBeforeSourceEdit = requests.length;
  assert.equal((await runtime.restoreExecutionState()).state, 'stale', 'restoration still rejects edits to preceding source messages');
  assert.equal(requests.length, callsBeforeSourceEdit, 'source invalidation does not start model work');
}
console.log('[pass] successive real-host card selection');

// Complete identity arrays must survive deck normalization and hand projection.
const { applyCardPlan, selectHand }=await import('../../src/cards.mjs');
const manyIds=Array.from({length:40},(_,i)=>`source-${i}`);
const provenanceDeck=applyCardPlan([],{acceptedCards:[{id:'many',family:'Scene Frame',role:'sceneFrameCard',promptText:'Relevant guidance.',status:'active',sourceCardIds:manyIds,sourceCards:manyIds.map(id=>({id}))}]});
assert.deepEqual(selectHand(provenanceDeck.cards,{maxCards:1}).cards[0].sourceCardIds,manyIds,'every used source receives cooldown');

const { snapshotsMatchForPromptInstall }=await import('../../src/runtime.mjs');
const sameVisible={chatKey:'c',messages:[{mesid:20,role:'user',text:'Unchanged visible input'}],sourceRevisionHash:'same-visible',cardSelectionSourcePrefixHash:'before'};
assert.equal(snapshotsMatchForPromptInstall(sameVisible,{...sameVisible,cardSelectionSourcePrefixHash:'after'}),false,'distant edit during provider work must stop stale install');

const pendingIdentity={snapshot:{chatKey:'pending',messages:[{mesid:1,role:'user',text:'Pending'}],cardSelectionSourcePrefixHash:'before',cardSelectionPendingUser:true},pendingUserMessage:{mesid:1,text:'Pending'}};
const committedIdentity={...pendingIdentity,snapshot:{...pendingIdentity.snapshot,cardSelectionSourcePrefixHash:'after',cardSelectionPreviousPrefixHash:'before',cardSelectionPendingUser:false}};
assert.equal((await createTurnIdentity(pendingIdentity)).turnKeyHash,(await createTurnIdentity(committedIdentity)).turnKeyHash,'committing pending input does not reroll same-turn selection');
