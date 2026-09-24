import assert from 'node:assert/strict';
import { hashJson } from '../../src/core.mjs';
import { createMemoryStorageAdapter, createStorageRepository } from '../../src/storage.mjs';
import { createPostProcessReview } from '../../src/post-process-review.mjs';
const repository = createStorageRepository({storage:createMemoryStorageAdapter()});
let identity = { chatIdentityHash:'chat-id', messageId:1, swipeId:0,
  originalHash:hashJson('Original.'), activeCharacterHash:'character', activeGroupHash:'' };
let commits = 0;
let restores = 0;
const snapshot = {chatKey:'chat',chatIdentityHash:'chat-id',sourceMessageId:1,sourceSwipeId:0,
  originalDraft:'Original.',sourceHash:hashJson('Original.'),activeCharacterHash:'character',activeGroupHash:''};
const operation = {operationId:'operation', snapshot, editingScope:'polish', applyMode:'as-swipe',
  reviewBeforeApplying:true,writer:{mode:'native',label:'Current SillyTavern model'},categories:[]};
const review = createPostProcessReview({
  repository, getChatKey:async()=> 'chat', readIdentity:async()=>identity, checkContext:async()=>true,
  restore:async(input)=>{restores++;assert.equal(input.originalSnapshot.originalDraft,'Original.');
    identity={...identity,swipeId:0,originalHash:hashJson('Original.')};
    return {ok:true,restored:true,identity};},
  commit:async(input)=>{commits++; identity={...identity,swipeId:1,originalHash:hashJson(input.text)};
    return {ok:true,applied:true,receipt:{commitId:input.commitId,finalArtifactHash:hashJson(input.text)}};}
});
const staged = await review.stage({operation,text:'Revised.'});
assert.equal(staged.reason,'awaiting-review');
assert.equal(commits,0);
const results = await Promise.all([review.act({id:staged.comparison.id,action:'apply'}),
  review.act({id:staged.comparison.id,action:'apply'})]);
assert.equal(results.every((result)=>result.ok),true);
assert.equal(commits,1);
assert.equal((await review.list())[0].candidateText,'Revised.');
assert.equal((await review.list())[0].state,'applied');
console.log('[pass] pending review applies once under concurrent clicks');

const previousRevisionId = (await review.list())[0].revisionId;
const edited = await review.act({id:staged.comparison.id,action:'edit',text:'Manually edited.'});
assert.equal(edited.ok,true);
assert.equal(edited.comparison.state,'pending');
assert.equal(edited.comparison.manualEdit,true);
assert.notEqual(edited.comparison.revisionId,previousRevisionId);
assert.equal(edited.comparison.originalSnapshot.originalDraft,'Original.');
assert.equal(commits,1);
console.log('[pass] manual editing prepares a distinct candidate without writing chat');

const kept = await review.act({id:staged.comparison.id,action:'keep'});
assert.equal(kept.ok,true);
assert.equal(kept.comparison.state,'rejected');
assert.equal(restores,1);
assert.equal(identity.originalHash,hashJson('Original.'));
console.log('[pass] Keep original restores owned prior application after editing');
// A crash after host commit but before local receipt must not append again.
identity={...identity,swipeId:0,originalHash:hashJson('Original.')};
const recovery = createPostProcessReview({repository,getChatKey:async()=> 'chat',
  readIdentity:async()=>identity,checkContext:async()=>true,
  reconcile:async()=>({targetMessageId:1,targetSwipeId:2,finalArtifactHash:hashJson('Recovered.')}),
  commit:async()=>{throw new Error('A reconciled candidate must not commit twice.');}});
const beforeCrash = await recovery.stage({operation:{...operation,operationId:'recovery-operation'},text:'Recovered.'});
identity={...identity,swipeId:2,originalHash:hashJson('Recovered.')};
const recovered = await recovery.act({id:beforeCrash.comparison.id,action:'apply'});
assert.equal(recovered.ok,true);
assert.equal(recovered.reason,'already-applied');
assert.equal(recovered.comparison.state,'applied');
console.log('[pass] host receipt reconciles interrupted local settlement');

// Opening review after a lost local receipt repairs state before computing eligibility.
identity={...identity,swipeId:0,originalHash:hashJson('Original.')};
const opened = await recovery.stage({operation:{...operation,operationId:'open-recovery'},text:'Recovered.'});
identity={...identity,swipeId:2,originalHash:hashJson('Recovered.')};
assert.equal((await recovery.list()).find(r=>r.id===opened.comparison.id).state,'applied');
console.log('[pass] opening review reconciles a committed pending revision');

let retryCalls=0;
const retryReview=createPostProcessReview({repository,getChatKey:async()=> 'chat',readIdentity:async()=>identity,
  retry:async(record,{signal})=>{retryCalls++;assert.equal(record.originalSnapshot.originalDraft,'Original.');assert.equal(signal.aborted,false);return {ok:true};}});
identity={...identity,swipeId:0,originalHash:hashJson('Original.')};
const retryRecord=await retryReview.stage({operation:{...operation,operationId:'retry'},text:'Try one.',retryInputs:{categories:[]}});
assert.equal((await retryReview.act({id:retryRecord.comparison.id,action:'retry'})).ok,true);
assert.equal(retryCalls,1);
await retryReview.invalidate({chatKey:'chat',reason:'new-turn'});
const expired=await repository.loadPostProcessComparison('chat','retry');
assert.equal(expired.state,'stale');
assert.equal(expired.retryInputs,null);
assert.equal((await retryReview.act({id:'retry',action:'retry'})).ok,false);
assert.equal(retryCalls,1);
console.log('[pass] stale revisions discard retry material and cannot regenerate');

identity={...identity,swipeId:0,originalHash:hashJson('Original.')};
let entered;
const waiting=new Promise(resolve=>{entered=resolve;});
const cancelReview=createPostProcessReview({repository,getChatKey:async()=> 'chat',readIdentity:async()=>identity,
  commit:async({signal})=>{entered();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return {ok:false,error:{code:'canceled'}};}});
await cancelReview.stage({operation:{...operation,operationId:'cancel'},text:'Canceled.'});
const pending=cancelReview.act({id:'cancel',action:'apply'});
await waiting;
assert.equal(cancelReview.isRunning(),true);
cancelReview.cancel('stop');
assert.equal((await pending).ok,false);
assert.equal(identity.originalHash,hashJson('Original.'));
assert.equal(cancelReview.isRunning(),false);
console.log('[pass] Stop aborts an in-flight review mutation');

// The host can have persisted Keep Original before comparison settlement fails.
identity={...identity,swipeId:0,originalHash:hashJson('Original.')};
let failedSave=false;
const restoreRecovery=createPostProcessReview({
 repository:{...repository,async savePostProcessComparison(key,record){
   if(record.state==='rejected' && !failedSave){failedSave=true;throw new Error('receipt write failed');}
   return repository.savePostProcessComparison(key,record);
 }},getChatKey:async()=> 'chat',readIdentity:async()=>identity,
 commit:async(input)=>{identity={...identity,swipeId:1,originalHash:hashJson(input.text)};return {ok:true};},
 restore:async()=>{identity={...identity,swipeId:0,originalHash:hashJson('Original.')};return {ok:true,identity};}
});
await restoreRecovery.stage({operation:{...operation,operationId:'restore-recovery'},text:'Revision.'});
await restoreRecovery.act({id:'restore-recovery',action:'apply'});
assert.equal((await restoreRecovery.act({id:'restore-recovery',action:'keep'})).ok,false);
assert.equal((await restoreRecovery.act({id:'restore-recovery',action:'keep'})).ok,true);
console.log('[pass] interrupted Keep Original settles safely on retry');
