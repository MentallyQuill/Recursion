import assert from 'node:assert/strict';
import { createSillyTavernHost } from '../../src/hosts/sillytavern/host.mjs';
import { createPostProcessRuntime } from '../../src/post-process-runtime.mjs';
import { createExecutionScheduler } from '../../src/execution/scheduler.mjs';
import { createMemoryStorageAdapter, createStorageRepository } from '../../src/storage.mjs';
import { createSettingsStore } from '../../src/settings.mjs';
const source='The rain stopped. "We should go," Mara said.';
const context={chatId:'revision-integration', chat:[
  {mesid:0,is_user:true,mes:'Continue.'},
  {mesid:1,is_user:false,mes:source,swipe_id:0,swipes:[source],swipe_info:[{extra:{}}]}
],saveChat(){},setExtensionPrompt(){},updateMessageBlock(){},swipe:{refresh(){}},
  generate:async()=> 'The rain eased to silence. "We should go," Mara said.'};
const host=createSillyTavernHost({contextFactory:()=>context,settingsRoot:{}});
const repository=createStorageRepository({storage:createMemoryStorageAdapter()});
const settingsStore=createSettingsStore({root:{recursion:{postProcess:{enabled:true,reviewBeforeApplying:true}}}});
let guidanceCalls=0; const requests=[];
const writerInputs=[];
const nativeGenerate=context.generate;
context.generate=async(type,options)=>{writerInputs.push(options.quiet_prompt); return nativeGenerate(type,options);};
const generationRouter={async generate(_role,request){guidanceCalls++; requests.push(request); return {ok:true,data:{
  guidanceText:'Tighten the rain description.',snapshotHash:request.snapshotHash,sourceHash:request.sourceHash
}};}};
const makeRuntime=()=>createPostProcessRuntime({host,settingsStore,generationRouter,
  durableExecution:{repository,scheduler:createExecutionScheduler({repository})}});
let runtime=makeRuntime();
const result=await runtime.runPostProcessForLatestAssistant();
assert.equal(result.reason,'awaiting-review');
assert.equal(result.committed,false);
assert.equal(context.chat[1].mes,source);
assert.equal(runtime.postProcessRunning(),false);
runtime=makeRuntime();
const [comparison]=await runtime.postProcessComparisons();
assert.equal(comparison.state,'pending');
const applied=await runtime.reviewPostProcess({id:comparison.id,action:'apply'});
assert.equal(applied.ok,true);
assert.equal(context.chat[1].swipes.length,2);
assert.equal(context.chat[1].mes,'The rain eased to silence. "We should go," Mara said.');
console.log('[pass] durable review survives recreation and applies through real host seam');


context.generate=async(_type,options)=>{writerInputs.push(options.quiet_prompt);return 'Another revision of the rain.';};
const retried=await runtime.reviewPostProcess({id:comparison.id,action:'retry'});
assert.equal(retried.ok,true);
assert.equal(retried.comparison.id,comparison.id);
assert.equal(retried.comparison.originalSnapshot.originalDraft,source);
assert.equal(retried.comparison.state,'pending');
assert.equal(context.chat[1].mes,'The rain eased to silence. "We should go," Mara said.');
assert.equal(guidanceCalls,1,'same guidance inputs reuse original guidance after recreation');
assert.ok(writerInputs.at(-1).endsWith(source),'retry writer starts from immutable original');
assert.equal(retried.comparison.targetIdentity.swipeId,1,'retry guards current applied target independently');
assert.equal((await runtime.reviewPostProcess({id:comparison.id,action:'apply'})).ok,true);
assert.equal(context.chat[1].swipes.length,3);
console.log('[pass] retry retains original, reuses guidance, and guards applied target');

const resolvedNative=host.generation.resolvePostProcessWriter.bind(host.generation);
host.generation.resolvePostProcessWriter=async writer=>({...await resolvedNative(writer),label:'Changed native writer',profileFingerprint:'writer-only-change'});
let countBefore=guidanceCalls;
assert.equal((await runtime.reviewPostProcess({id:comparison.id,action:'retry'})).ok,true);
assert.equal(guidanceCalls,countBefore,'writer-only changes retain matching guidance');
settingsStore.update({postProcess:{editingScope:'revise'}});
assert.equal((await runtime.reviewPostProcess({id:comparison.id,action:'retry'})).ok,true);
assert.equal(guidanceCalls,countBefore+1,'scope change regenerates guidance');
const previousRevision=(await runtime.postProcessComparisons())[0].revisionId;
context.generate=async()=>source;
const unchangedRetry=await runtime.reviewPostProcess({id:comparison.id,action:'retry'});
assert.equal(unchangedRetry.ok,true);
assert.equal(unchangedRetry.comparison.candidateText,source,'unchanged retry replaces prior candidate with actual writer result');
assert.notEqual(unchangedRetry.comparison.revisionId,previousRevision);
assert.equal(unchangedRetry.comparison.state,'pending');
assert.equal(context.chat[1].swipes.length,3,'retry preserves previously applied text until acceptance');
console.log('[pass] retry returning original creates a new pending revision');
const beforeCancel=(await runtime.postProcessComparisons())[0];
let entered=false;
context.generate=()=>{entered=true;return new Promise(()=>{});};
const canceledRetry=runtime.reviewPostProcess({id:comparison.id,action:'retry'});
for(let i=0;i<100&&!entered;i++) await new Promise(resolve=>setTimeout(resolve,0));
assert.equal(entered,true);
assert.equal(runtime.postProcessRunning(),true);
runtime.cancelPostProcess('user');
const canceledResult=await canceledRetry;
assert.equal(canceledResult.ok,false);
assert.equal((await runtime.postProcessComparisons())[0].revisionId,beforeCancel.revisionId,'canceled retry preserves previous comparison');
assert.equal(context.chat[1].swipes.length,3,'canceled retry never mutates selected response');
console.log('[pass] writer-only cache reuse, scope invalidation, and retry cancellation');

{
  const original='Progressive original.';
  const c={chatId:'progressive-retry',chat:[{mesid:0,is_user:true,mes:'Continue.'},
    {mesid:1,is_user:false,mes:original,swipe_id:0,swipes:[original],swipe_info:[{extra:{}}]}],
    saveChat(){},setExtensionPrompt(){},updateMessageBlock(){},swipe:{refresh(){}}};
  const outputs=['First draft v1','Final draft v1','First draft v2','Final draft v2'];
  c.generate=async()=>outputs.shift();
  const h=createSillyTavernHost({contextFactory:()=>c,settingsRoot:{}});
  const repo=createStorageRepository({storage:createMemoryStorageAdapter()});
  const inputDrafts=[];
  const deck={id:'two',name:'Two',categoryOrder:['first','second'],categories:{first:{id:'first',name:'First',enabled:true},second:{id:'second',name:'Second',enabled:true}},
    cardOrderByCategory:{first:['a'],second:['b']},cards:{a:{id:'a',categoryId:'first',name:'A',promptText:'Edit A',enabled:true},b:{id:'b',categoryId:'second',name:'B',promptText:'Edit B',enabled:true}}};
  const rt=createPostProcessRuntime({host:h,settingsStore:{get:()=>({reasoningLevel:'medium',postProcess:{enabled:true,reviewBeforeApplying:true,rewriteFlow:'progressive'}})},
    deckProvider:()=>deck,generationRouter:{generate:async(_role,request)=>{inputDrafts.push(request.draft);return {ok:true,data:{guidanceText:'Revise selected category.',snapshotHash:request.snapshotHash,sourceHash:request.sourceHash}};}},
    durableExecution:{repository:repo,scheduler:createExecutionScheduler({repository:repo})}});
  await rt.runPostProcessForLatestAssistant();
  const [record]=await rt.postProcessComparisons();
  assert.equal((await rt.reviewPostProcess({id:record.id,action:'retry'})).ok,true);
  assert.deepEqual(inputDrafts,[original,'First draft v1','First draft v2'],'Progressive reuse follows actual earlier writer output');
  assert.equal((await rt.postProcessComparisons())[0].candidateText,'Final draft v2');
}
console.log('[pass] Progressive retry regenerates guidance when earlier draft changes');

{
  const original='Pause original.';
  const c={chatId:'pause-review',chat:[{mesid:0,is_user:true,mes:'Continue.'},{mesid:1,is_user:false,mes:original,swipe_id:0,swipes:[original],swipe_info:[{extra:{}}]}],saveChat(){},setExtensionPrompt(){},updateMessageBlock(){},swipe:{refresh(){}},generate:async()=> 'Paused candidate.'};
  const h=createSillyTavernHost({contextFactory:()=>c,settingsRoot:{}});
  const repo=createStorageRepository({storage:createMemoryStorageAdapter()});
  let entered,release;
  const entering=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  const save=repo.savePostProcessComparison;
  repo.savePostProcessComparison=async(...args)=>{if(args[1].state==='pending'){entered();await gate;}return save(...args);};
  const scheduler=createExecutionScheduler({repository:repo});
  let operationId;
  const rt=createPostProcessRuntime({host:h,settingsStore:{get:()=>({reasoningLevel:'medium',postProcess:{enabled:true,reviewBeforeApplying:false}})},
    generationRouter:{generate:async(_role,request)=>({ok:true,data:{guidanceText:'Polish.',snapshotHash:request.snapshotHash,sourceHash:request.sourceHash}})},
    durableExecution:{repository:repo,scheduler,onOperation:({operation})=>{operationId=operation.operationId;}}});
  const running=rt.runPostProcessForLatestAssistant();
  await entering;
  assert.equal((await scheduler.pause({operationId,reason:'user'})).state,'paused');
  release();
  await running;
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(c.chat[1].mes,original,'scheduler cancellation reaches comparison persistence and final commit');
  assert.equal(c.chat[1].swipes.length,1);
}
console.log('[pass] scheduler pause during comparison persistence prevents late host write');
