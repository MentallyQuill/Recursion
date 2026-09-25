import assert from 'node:assert/strict';
import { createPostProcessRuntime } from '../../src/post-process-runtime.mjs';
import { createExecutionScheduler } from '../../src/execution/scheduler.mjs';
import { createMemoryStorageAdapter, createStorageRepository } from '../../src/storage.mjs';
import { createSettingsStore } from '../../src/settings.mjs';
import { createSillyTavernHost } from '../../src/hosts/sillytavern/host.mjs';

function harness({ write, diagnostic = async () => {}, review = false, timeoutMs = null } = {}) {
  const source = 'Original response.';
  const context = {chatId:'outcome-chat', chat:[{mesid:0,is_user:true,mes:'Continue.'},
    {mesid:1,is_user:false,mes:source,swipe_id:0,swipes:[source],swipe_info:[{extra:{}}]}],
    saveChat(){},setExtensionPrompt(){},updateMessageBlock(){},swipe:{refresh(){}},generate:write};
  const host = createSillyTavernHost({contextFactory:()=>context,settingsRoot:{}});
  if (timeoutMs) { const rewrite=host.generation.rewriteWithPostProcess; host.generation.rewriteWithPostProcess=input=>rewrite({...input,timeoutMs}); }
  const repository = createStorageRepository({storage:createMemoryStorageAdapter()});
  const scheduler = createExecutionScheduler({repository,attemptsPerStep:1});
  const events = [], diagnostics = [];
  const runtime = createPostProcessRuntime({host,
    settingsStore:createSettingsStore({root:{recursion:{modelAttemptsPerStep:1,postProcess:{enabled:true,reviewBeforeApplying:review}}}}),
    generationRouter:{generate:async(_role,request)=>({ok:true,data:{guidanceText:'Polish.',snapshotHash:request.snapshotHash,sourceHash:request.sourceHash}})},
    activity:{start:event=>events.push(event),settle:event=>events.push(event)},
    onDiagnostic:async summary=>{diagnostics.push(summary);await diagnostic(summary);},
    durableExecution:{repository,scheduler}});
  return {runtime,context,events,diagnostics,repository};
}

{
  const h = harness({write:async()=>{throw Object.assign(new Error('secret provider body'),{code:'RECURSION_POST_PROCESS_WRITER_TIMEOUT',retryable:false});}});
  const failed = await h.runtime.runPostProcessForLatestAssistant();
  assert.equal(failed.diagnostics.status,'failed');
  assert.equal(failed.diagnostics.failure.stageId,'postprocess.unified.rewrite');
  assert.equal(failed.diagnostics.failure.code,'RECURSION_POST_PROCESS_WRITER_TIMEOUT');
  assert.ok(failed.diagnostics.chatKey);
  assert.ok(failed.diagnostics.startedAt && failed.diagnostics.finishedAt);
  assert.ok(failed.diagnostics.elapsedMs >= 0);
  assert.equal(failed.diagnostics.writer.mode,'native');
  assert.match(failed.diagnostics.failure.message,/time limit/i);
  assert.ok(!JSON.stringify(failed.diagnostics).includes('secret provider body'));
  assert.equal(h.events.at(-1).outcome,'error');
  assert.equal(h.diagnostics.length,1);
  h.context.generate = async()=> 'Revised response.';
  const retry = await h.runtime.retryStage({operationId:failed.execution.operationId,stageId:'postprocess.unified.rewrite'});
  assert.equal(retry.diagnostics.status,'applied');
  assert.equal(h.diagnostics.length,2);
  assert.equal(h.context.chat[1].swipes.length,2);
}
{
  let resolveWriter, entered;
  const started = new Promise(resolve=>{entered=resolve;});
  const h = harness({write:()=>{entered();return new Promise(resolve=>{resolveWriter=resolve;});}});
  const run = h.runtime.runPostProcessForLatestAssistant();
  await started;
  assert.equal(h.runtime.postProcessDiagnostics().status,'writing');
  h.runtime.cancelPostProcess();
  const canceled = await run;
  assert.equal(canceled.diagnostics.status,'canceled');
  assert.equal(h.events.at(-1).outcome,'canceled');
  assert.equal(h.diagnostics.length,1);
  resolveWriter('Late revision.');
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(h.context.chat[1].swipes.length,1);
  assert.equal(h.runtime.postProcessDiagnostics().status,'canceled');
  assert.equal(h.diagnostics.length,1);
}
for (const [output, review, status] of [['Original response.',false,'no-change'],['Revised response.',true,'awaiting-review'],['Revised response.',false,'applied']]) {
  let persisted = false;
  const h = harness({write:async()=>output,review,diagnostic:async()=>{await Promise.resolve();persisted=true;throw new Error('sink unavailable');}});
  const result = await h.runtime.runPostProcessForLatestAssistant();
  assert.equal(result.ok,true);
  assert.equal(result.diagnostics.status,status);
  assert.equal(persisted,true,'terminal persistence awaited and sink failure isolated');
  assert.equal(h.diagnostics.length,1);
  if (review) {
    const [comparison] = await h.runtime.postProcessComparisons();
    assert.equal((await h.runtime.reviewPostProcess({id:comparison.id,action:'apply'})).ok,true);
    assert.equal(h.runtime.postProcessDiagnostics().status,'applied');
    assert.equal(h.diagnostics.length,2);
    await h.runtime.reviewPostProcess({id:comparison.id,action:'apply'});
    assert.equal(h.diagnostics.length,2,'already applied does not publish a duplicate outcome');
  }
}
console.log('[pass] source-bound outcomes, failed settlement, retry, cancellation, late writes, terminal persistence');


{
  let resolveWriter;
  const h=harness({timeoutMs:5,write:()=>new Promise(resolve=>{resolveWriter=resolve;})});
  const result=await h.runtime.runPostProcessForLatestAssistant();
  assert.equal(result.diagnostics.status,'failed');
  assert.equal(result.diagnostics.failure.code,'RECURSION_POST_PROCESS_WRITER_TIMEOUT');
  resolveWriter('Late timed-out revision.');
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(h.runtime.postProcessDiagnostics().status,'failed');
  assert.equal(h.context.chat[1].swipes.length,1);
  assert.equal(h.diagnostics.length,1);
}
console.log('[pass] deadline failure survives late native writer resolution');
{
  const h=harness({write:async()=> 'Revision A.',review:true});
  await h.runtime.runPostProcessForLatestAssistant();
  const [comparison]=await h.runtime.postProcessComparisons();
  await h.runtime.reviewPostProcess({id:comparison.id,action:'apply'});
  h.context.generate=async()=>h.context.chat[1].mes;
  const latest=await h.runtime.runPostProcessForLatestAssistant();
  assert.equal(latest.diagnostics.status,'no-change');
  const count=h.diagnostics.length;
  const reapplied=await h.runtime.reviewPostProcess({id:comparison.id,action:'apply'});
  assert.equal(reapplied.reason,'already-applied');
  assert.equal(h.diagnostics.length,count,'old acceptance cannot republish over later operation');
  assert.equal(h.runtime.postProcessDiagnostics().operationId,latest.diagnostics.operationId);
  await h.runtime.reviewPostProcess({id:comparison.id,action:'keep'});
  const afterKeep=await h.runtime.runPostProcessForLatestAssistant();
  const keepCount=h.diagnostics.length;
  await h.runtime.reviewPostProcess({id:comparison.id,action:'keep'});
  assert.equal(h.diagnostics.length,keepCount,'repeated keep cannot republish over later operation');
  assert.equal(h.runtime.postProcessDiagnostics().operationId,afterKeep.diagnostics.operationId);
}
console.log('[pass] old review no-ops preserve latest operation outcome');

{
  const h=harness({write:async()=> 'Applied before checkpoint failure.'});
  const save=h.repository.savePipelineArtifact;
  h.repository.savePipelineArtifact=async(...args)=>{
    if (args[2].startsWith('postprocess.host-commit.')) throw Object.assign(new Error('checkpoint unavailable'),{code:'RECURSION_STAGE_ARTIFACT_WRITE_FAILED',category:'storage',retryable:false});
    return save(...args);
  };
  const result=await h.runtime.runPostProcessForLatestAssistant();
  assert.equal(result.diagnostics.status,'failed');
  assert.equal(h.context.chat[1].swipes.length,2,'host commit can precede failed artifact persistence');
  assert.match(result.diagnostics.failure.message,/check.*response/i);
  assert.doesNotMatch(result.diagnostics.failure.message,/Original.*preserved/i);
}
console.log('[pass] uncertain commit failure does not falsely claim original preserved');
