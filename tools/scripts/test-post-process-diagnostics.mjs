import assert from 'node:assert/strict';
import { buildDiagnosticsPayload } from '../../src/runtime/diagnostics.mjs';
import { createStorageRepository, createMemoryStorageAdapter, runJournalKey } from '../../src/storage.mjs';

const adapter = createMemoryStorageAdapter();
const storage = createStorageRepository({storage:adapter,maxJournalEntries:10});
const outcome = {chatKey:'chat-a',operationId:'post-failed',status:'failed',reason:'stage-failed:postprocess.unified.rewrite',
  startedAt:'2026-09-25T03:00:00.000Z',finishedAt:'2026-09-25T03:03:00.000Z',elapsedMs:180000,
  writer:{mode:'profile',connectionProfileId:'writer-profile',model:'writer-model',apiKey:'CANARY_KEY',endpoint:'https://private.invalid/key'},
  failure:{stageId:'postprocess.unified.rewrite',code:'RECURSION_POST_PROCESS_WRITER_TIMEOUT',message:'Writer timed out. Bearer sensitive-token',failureClass:'provider-timeout',retryable:true},
  originalDraft:'CANARY_DRAFT',candidateText:'CANARY_CANDIDATE',request:{messages:['CANARY_PROMPT']},requestedApplyMode:'as-swipe'};
await storage.appendJournal('chat-a',{event:'postprocess.outcome',runId:outcome.operationId,details:outcome});
for(let i=0;i<25;i++)await storage.appendJournal('chat-a',{event:'provider.call.completed',summary:'Later preprocess',runId:'pre-'+i});
let journal = await storage.loadRunJournal('chat-a');
assert.equal(journal.entries.length,10);
assert.equal(journal.postProcessOutcomes?.length,1,'post-process failure survives normal journal eviction');
assert.equal(journal.postProcessOutcomes[0].failure.code,outcome.failure.code);
assert.equal(journal.postProcessOutcomes[0].writer.model,'writer-model');
for(const forbidden of ['CANARY_DRAFT','CANARY_CANDIDATE','CANARY_KEY','CANARY_PROMPT','sensitive-token','private.invalid'])assert(!JSON.stringify(adapter.dump()).includes(forbidden),'persisted summary excludes '+forbidden);
const fresh=createStorageRepository({storage:adapter,maxJournalEntries:10});
assert.equal((await fresh.loadRunJournal('chat-a')).postProcessOutcomes[0].operationId,'post-failed','outcomes survive repository recreation');
let payload=buildDiagnosticsPayload({chatKey:'chat-a',journal:await fresh.loadRunJournal('chat-a'),view:{execution:{operationId:'new-preprocess',phase:'preprocess',state:'running',stageRecords:{}}}});
assert.equal(payload.runtime.postProcessHistory[0].failure.code,outcome.failure.code,'export keeps prior post-process failure beside current preprocessing');
assert.equal(payload.runtime.postProcessStatus.operationId,'post-failed','export restores latest terminal summary');
assert.equal(payload.runtime.execution.operationId,'new-preprocess');
payload=buildDiagnosticsPayload({chatKey:'chat-b',journal:await fresh.loadRunJournal('chat-b'),view:{postProcessStatus:outcome}});
assert.equal(payload.runtime.postProcessStatus,null,'another chat cannot inherit last post-process status');
assert.deepEqual(payload.runtime.postProcessHistory,[]);
await Promise.all(Array.from({length:30},(_,i)=>fresh.appendJournal('race-chat',{event:'provider.call.completed',runId:'parallel-'+i})));
assert.equal((await fresh.loadRunJournal('race-chat')).nextIndex,30,'parallel journal writes do not lose entries');
for(let i=0;i<24;i++)await fresh.appendJournal('chat-a',{event:'postprocess.outcome',details:{...outcome,operationId:'post-'+i,finishedAt:new Date(Date.UTC(2026,8,25,4,0,i)).toISOString()}});
journal=await fresh.loadRunJournal('chat-a');assert.equal(journal.postProcessOutcomes.length,12,'retained history is bounded independently of ordinary entries');
await fresh.appendJournal('chat-a',{event:'postprocess.outcome',details:journal.postProcessOutcomes.at(-1)});
assert.equal((await fresh.loadRunJournal('chat-a')).postProcessOutcomes.length,12,'identical outcome is idempotent');
await assert.rejects(fresh.appendJournal('chat-a',{event:'postprocess.outcome',details:{...outcome,chatKey:'chat-b'}}),/another chat/);
assert((await fresh.loadRunJournal('chat-a')).postProcessOutcomes.every(x=>x.chatKey==='chat-a'),'cross-chat outcome is rejected');
await fresh.clearRunJournal('chat-a');assert.equal(adapter.dump()[runJournalKey('chat-a')],undefined,'clear removes retained outcomes as well');
console.log('[pass] persistent post-process diagnostics and concurrent journal custody');
import { createRecursionRuntime } from '../../src/runtime.mjs';
import { createSillyTavernHost } from '../../src/hosts/sillytavern/host.mjs';
import { createSettingsStore } from '../../src/settings.mjs';

const rootAdapter=createMemoryStorageAdapter();
const rootStorage=createStorageRepository({storage:rootAdapter});
const context={chatId:'root-outcome',chat:[{mesid:0,is_user:true,mes:'Continue.'},{mesid:1,is_user:false,mes:'Original.',swipe_id:0,swipes:['Original.'],swipe_info:[{extra:{}}]}],saveChat(){},setExtensionPrompt(){},updateMessageBlock(){},swipe:{refresh(){}},generate:async()=>{throw Object.assign(new Error('private provider text'),{code:'RECURSION_POST_PROCESS_WRITER_TIMEOUT',retryable:false});}};
const rootHost=createSillyTavernHost({contextFactory:()=>context,settingsRoot:{}});
const rootSettings=createSettingsStore({root:{recursion:{modelAttemptsPerStep:1,postProcess:{enabled:true}}}});
const rootOptions={host:rootHost,storage:rootStorage,settingsStore:rootSettings,generationRouter:{generate:async(_role,request)=>({ok:true,data:{guidanceText:'Polish.',snapshotHash:request.snapshotHash,sourceHash:request.sourceHash}})}};
const rootRuntime=createRecursionRuntime(rootOptions);
const rootFailure=await rootRuntime.runPostProcessForLatestAssistant();
assert.equal(rootRuntime.view().postProcessStatus?.status,'failed','root runtime exposes terminal post-process status');
const rootChat=rootFailure.diagnostics.chatKey;
assert.equal((await rootStorage.loadRunJournal(rootChat)).postProcessOutcomes[0].failure.code,'RECURSION_POST_PROCESS_WRITER_TIMEOUT','root runtime persists terminal callback');
assert.equal((await rootRuntime.exportDiagnostics()).diagnostics.runtime.postProcessStatus.status,'failed');
await rootRuntime.dispose();
await rootStorage.clearPipelineRun(rootChat);
const reloaded=createRecursionRuntime(rootOptions);
await reloaded.restoreExecutionState();
assert.equal(reloaded.view().postProcessStatus?.status,'failed','restore keeps outcome even after execution manifest replaced or removed');
assert.equal((await reloaded.exportDiagnostics()).diagnostics.runtime.postProcessHistory.length,1);
context.chatId='other-root-chat';
assert.equal((await reloaded.exportDiagnostics()).diagnostics.runtime.postProcessStatus,null,'export checks host chat before UI change event');
await reloaded.handleChatChanged();
assert.equal(reloaded.view().postProcessStatus,null,'chat change hides other chat failure');
context.chatId='root-outcome';
await reloaded.handleChatChanged();
assert.equal(reloaded.view().postProcessStatus?.status,'failed','returning to chat restores terminal status');
await reloaded.clearRunJournal();
assert.equal(reloaded.view().postProcessStatus,null,'clear journal also clears retained status');
await reloaded.dispose();
console.log('[pass] root runtime persistence, reload, chat changes and current-chat export');


function deferred() {
  let resolve;
  const promise = new Promise(settle => { resolve = settle; });
  return { promise, resolve };
}

// Disposal must drain the terminal callback before a replacement runtime can reload.
{
  const repository = createStorageRepository({ storage: createMemoryStorageAdapter() });
  const entered = deferred(), release = deferred();
  const append = repository.appendJournal;
  repository.appendJournal = async (...args) => {
    if (args[1].event === 'postprocess.outcome') {
      entered.resolve();
      await release.promise;
    }
    return append(...args);
  };
  context.chatId = 'dispose-outcome';
  const runtime = createRecursionRuntime({ ...rootOptions, storage: repository });
  const running = runtime.runPostProcessForLatestAssistant();
  await entered.promise;
  let disposed = false;
  const disposing = runtime.dispose().then(() => { disposed = true; });
  await new Promise(resolve => setImmediate(resolve));
  const disposedBeforePersistence = disposed;
  release.resolve();
  const result = await running;
  await disposing;
  assert.equal(disposedBeforePersistence, false, 'dispose waits for terminal diagnostic persistence');
  assert.equal((await repository.loadRunJournal(result.diagnostics.chatKey)).postProcessOutcomes.length, 1,
    'terminal outcome is durable when dispose returns');
}
console.log('[pass] disposal drains pending terminal outcome persistence');

// An older restore may finish after the operator has switched to another chat.
{
  const repository = createStorageRepository({ storage: createMemoryStorageAdapter() });
  for (const key of ['restore-a', 'restore-b']) {
    await repository.appendJournal(key, { event: 'postprocess.outcome', details: {
      ...outcome, chatKey: key, operationId: key
    } });
  }
  const entered = deferred(), release = deferred();
  const load = repository.loadRunJournal;
  let delayFirst = true;
  repository.loadRunJournal = async key => {
    const journal = await load(key);
    if (key === 'restore-a' && delayFirst) {
      delayFirst = false;
      entered.resolve();
      await release.promise;
    }
    return journal;
  };
  context.chatId = 'restore-a';
  const runtime = createRecursionRuntime({ ...rootOptions, storage: repository });
  const restoring = runtime.restoreExecutionState();
  await entered.promise;
  context.chatId = 'restore-b';
  await runtime.handleChatChanged();
  assert.equal(runtime.view().postProcessStatus?.operationId, 'restore-b', 'new chat restores its outcome');
  release.resolve();
  await restoring;
  assert.equal(runtime.view().postProcessStatus?.operationId, 'restore-b',
    'late old-chat restore cannot replace the current chat outcome');
  await runtime.dispose();
}
console.log('[pass] late old-chat restore preserves current chat outcome');

// The same guard must protect a newer live outcome from an older journal read.
{
  const repository = createStorageRepository({ storage: createMemoryStorageAdapter() });
  const key = 'restore-newer-outcome';
  await repository.appendJournal(key, { event: 'postprocess.outcome', details: {
    ...outcome, chatKey: key, operationId: 'old-outcome'
  } });
  const entered = deferred(), release = deferred();
  const load = repository.loadRunJournal;
  let delayFirst = true;
  repository.loadRunJournal = async chatKey => {
    const journal = await load(chatKey);
    if (chatKey === key && delayFirst) {
      delayFirst = false;
      entered.resolve();
      await release.promise;
    }
    return journal;
  };
  context.chatId = key;
  const runtime = createRecursionRuntime({ ...rootOptions, storage: repository });
  const restoring = runtime.restoreExecutionState();
  await entered.promise;
  const latest = await runtime.runPostProcessForLatestAssistant();
  release.resolve();
  await restoring;
  assert.equal(runtime.view().postProcessStatus?.operationId, latest.diagnostics.operationId,
    'late same-chat restore cannot replace a newer terminal outcome');
  await runtime.dispose();
}
console.log('[pass] late same-chat restore preserves newer terminal outcome');

// Export can occur before the host dispatches its chat-change event.
{
  context.chatId = 'export-source-chat';
  const runtime = createRecursionRuntime({ ...rootOptions,
    storage: createStorageRepository({ storage: createMemoryStorageAdapter() }) });
  const failed = await runtime.runPostProcessForLatestAssistant();
  assert(failed.execution.operationId, 'source chat has an execution to protect');
  context.chatId = 'export-current-chat';
  const exported = (await runtime.exportDiagnostics()).diagnostics;
  assert.equal(exported.runtime.postProcessStatus, null, 'fresh chat export excludes old terminal status');
  assert.equal(exported.runtime.execution, null, 'fresh chat export excludes old execution before chat-change event');
  assert(!JSON.stringify(exported.runtime).includes(failed.execution.operationId),
    'fresh chat runtime projection excludes stale operation identity');
  await runtime.dispose();
}
console.log('[pass] current-chat export excludes cached execution from another chat');
