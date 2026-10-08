import assert from 'node:assert/strict';
import { createStorageRepository, createMemoryStorageAdapter } from '../../src/storage.mjs';
import { createExecutionScheduler } from '../../src/execution/scheduler.mjs';
import { createExecutionGraph } from '../../src/execution/stage-registry.mjs';
import { createPipelineRun } from '../../src/execution/checkpoints.mjs';
import { buildDiagnosticsPayload } from '../../src/runtime/diagnostics.mjs';
import { buildOperationSummary, normalizeOperationSummaries } from '../../src/storage/operation-history.mjs';
import { normalizeAttemptOutcomes } from '../../src/execution/attempt-outcomes.mjs';
import { createActivityReporter } from '../../src/activity.mjs';
import { CARD_SCOPE_CATALOG } from '../../src/card-scope.mjs';

const repository = createStorageRepository({ storage:createMemoryStorageAdapter(), maxJournalEntries:10 });
const provenance = { chatKey:'synthetic-chat', sourceIdentity:{sourceRevisionHash:'synthetic-source'},
  settingsHash:'synthetic-settings', provider:{id:'synthetic-profile',model:'synthetic-model'}, pipelineMode:'segmented' };
function manifest(operationId = 'synthetic-operation', chatKey = 'synthetic-chat') {
  return createPipelineRun({operationId,chatKey,phase:'preprocess',pipelineMode:'segmented',
    turnKeyHash:'synthetic-turn',sourceBandHash:'synthetic-band',sourceIdentity:provenance.sourceIdentity,
    provenance:{...provenance,chatKey},createdAt:'2026-10-07T12:00:00.000Z'});
}
let calls = 0;
const graph = createExecutionGraph({stages:[{
  id:'preprocess.guidance',version:1,kind:'model',executable:true,checkpoint:'durable',dependencies:[],failurePolicy:'blocking',
  buildInputFingerprint: () => ({fixture:'synthetic'}),
  buildRequest: () => ({prompt:'initial synthetic request'}),
  buildCorrectionRequest: ({request}) => ({...request,prompt:'corrected synthetic request'}),
  run: async () => { calls++; return {accepted:calls > 1,timings:{queueMs:12,providerMs:20},usage:{inputTokens:10,totalTokens:30}}; },
  validate: value => value.accepted ? {ok:true,value} : {ok:false,error:{
    code:'RECURSION_JSON_PARSE_FAILED',category:'validation',message:'PRIVATE_CANARY',
    fieldIssues:[{path:'$.promptText',rule:'type',message:'PRIVATE_CANARY'}]}},
  summarizeArtifact: () => ({accepted:true})
}]});
const scheduler = createExecutionScheduler({repository,attemptsPerStep:2});
const result = await scheduler.start({manifest:manifest(),graph});
const saved = await repository.loadPipelineRun('synthetic-chat');
assert.equal(result.state, 'completed');
assert.equal(saved.stageRecords['preprocess.guidance'].failure, null);
const outcomes = saved.stageRecords['preprocess.guidance'].attemptOutcomes;
assert.equal(outcomes?.length, 2, 'a corrected success retains the rejected and accepted attempt');
assert.equal(outcomes[0].code, 'RECURSION_JSON_PARSE_FAILED');
assert.equal(outcomes[0].fieldIssues[0].rule, 'type');
assert.equal(outcomes[1].outcome, 'accepted');
assert.equal(outcomes[1].timings.queueMs, 12, 'actual provider timing survives accepted attempt settlement');
assert(!JSON.stringify(outcomes).includes('PRIVATE_CANARY'));
for (let i = 0; i < 500; i++) await repository.appendJournal('synthetic-chat', {
  severity:'info',event:'prompt.cleared',summary:'Synthetic cleanup',details:{}});
const journal = await repository.loadRunJournal('synthetic-chat');
assert.equal(journal.entries.length, 10);
assert.equal(journal.operationSummaries?.length, 1, 'retained operation survives ordinary ring rollover');
assert.equal(journal.operationSummaries[0].outcome, 'completed');
assert.equal(journal.operationSummaries[0].stages[0].attempts[0].code, 'RECURSION_JSON_PARSE_FAILED');
assert.equal(journal.operationSummaries[0].recoveryCounts.correctionRequests, 1);
const exported = buildDiagnosticsPayload({journal,chatKey:'synthetic-chat'});
assert.equal(exported.operationSummaries?.length, 1, 'sanitized exports retain operation explanations');
assert.equal(exported.operationSummaries[0].stages[0].attempts[0].code, 'RECURSION_JSON_PARSE_FAILED');
assert(!JSON.stringify(exported.operationSummaries).includes('PRIVATE_CANARY'));
const configured = manifest('configured');
configured.configuration = {mode:'auto',cardsPerTurn:6,reasoningLevel:'medium',reasonerUse:'auto',
  settingsHash:'abcdef01',providerHash:'12345678',prompt:'PRIVATE_CANARY'};
await repository.savePipelineRun('synthetic-chat',configured);
const captured = (await repository.loadRunJournal('synthetic-chat')).operationSummaries.at(-1).configuration;
assert.deepEqual(captured,{mode:'auto',cardsPerTurn:6,reasoningLevel:'medium',reasonerUse:'auto',
  settingsHash:'abcdef01',providerHash:'12345678'},'history preserves the operation configuration, without private extras');
configured.configuration.cardsPerTurn=0;
await repository.savePipelineRun('synthetic-chat',configured);
assert.equal((await repository.loadRunJournal('synthetic-chat')).operationSummaries.at(-1).configuration.cardsPerTurn,0,
  'zero is a valid saved card target');
configured.configuration.reasoningLevel='low';
configured.configuration.reasonerUse='off';
await repository.savePipelineRun('synthetic-chat',configured);
assert.equal((await repository.loadRunJournal('synthetic-chat')).operationSummaries.at(-1).configuration.reasonerUse,'off',
  'capture the actual Low routing policy');
// Bounds preserve aggregate counts and drop arbitrary provider fields/codes.
const many = {...manifest('many'),state:'completed',stageRecords:Object.fromEntries(Array.from({length:33}, (_,i) => [
  `stage-${i}`, {stageId:`stage-${i}`,state:'completed',kind:'model',attempts:{total:6},recoveryCounts:{parseFailures:6},
    attemptOutcomes:Array.from({length:6},(_,a)=>({attempt:a+1,window:1,outcome:'rejected',action:'retry-corrected',
      code:'RECURSION_JSON_PARSE_FAILED',response:'PRIVATE_CANARY'}))}]))};
const bounded = buildOperationSummary(many);
assert.equal(bounded.stageCount,33);
assert.equal(bounded.stages.length,32);
assert.equal(bounded.totalAttempts,198);
assert.equal(bounded.recoveryCounts.parseFailures,198);
assert.equal(bounded.stages[0].attempts.length,5);
assert.equal(bounded.stages[0].attempts[0].attempt,2);
assert(!JSON.stringify(bounded).includes('PRIVATE_CANARY'));
const unsafe = normalizeAttemptOutcomes([{outcome:'rejected',action:'PRIVATE_CANARY',code:'RECURSION_PRIVATE_CANARY',
  validationRule:'PRIVATE_CANARY',fieldIssues:[{rule:'type',path:'$.promptText',message:'PRIVATE_CANARY'}],
  timings:{queueMs:4,response:'PRIVATE_CANARY'},usage:{totalTokens:30,secret:'PRIVATE_CANARY'},payload:'PRIVATE_CANARY'}])[0];
assert.equal(unsafe.code,'RECURSION_ATTEMPT_FAILURE_UNKNOWN');
assert.equal(unsafe.validationRule,undefined);
assert(!JSON.stringify(unsafe).includes('PRIVATE_CANARY'));
const all = Array.from({length:21}, (_,i) => ({...bounded,operationId:`operation-${i}`}));
const evicted = normalizeOperationSummaries(all);
assert.equal(evicted.length,20);
assert.equal(evicted[0].operationId,'operation-1');
assert.equal(normalizeOperationSummaries([...all,{...bounded,operationId:'operation-1'}]).at(-1).operationId,'operation-1');
for (const [state,pauseReason,outcome] of [['paused','restored-after-reload','interrupted'], ['paused','user-stop','canceled'],
  ['paused','stage-failed:guidance','failed'],['running','','running'],['stale','','stale'],['abandoned','','abandoned']]) {
  const classified = buildOperationSummary({...manifest(),state,pauseReason});
  assert.equal(classified.outcome,outcome);
  if (outcome === 'interrupted') assert(classified.diagnosticCodes?.includes('operation-interrupted-after-reload'),
    'retained interruption history carries its fixed code');
}
assert.equal(buildOperationSummary({...many,stageRecords:{optional:{stageId:'optional',state:'failed',
  recoveryCounts:{optionalOmissions:1}}}}).outcome,'completed-with-omissions');
const declaredBuild = {schema:'recursion.buildInfo.v1',version:'0.3.0-beta.1',sourceRevision:'a'.repeat(40),
  dirty:false,productionHash:'a'.repeat(64),createdAt:'2026-10-07T12:00:00.000Z'};
const firstUnknown = buildOperationSummary(manifest());
const resumed = buildOperationSummary(manifest(),{previous:firstUnknown,build:declaredBuild});
assert.equal(resumed.firstObservedBuild.status,'unavailable');
assert.equal(resumed.latestBuild.status,'declared');
const badStorage = createMemoryStorageAdapter();
const activity = createActivityReporter();
activity.start({runId:saved.operationId,label:'Synthetic operation'});
const failingRepo = createStorageRepository({activity, storage:{...badStorage,
  writeJson:(key,value) => value.recordType === 'recursion.runJournal' ? {ok:false,persisted:false} : badStorage.writeJson(key,value)}});
assert.equal((await failingRepo.savePipelineRun('synthetic-chat',saved)).state,'completed');
assert.equal((await failingRepo.loadPipelineRun('synthetic-chat')).state,'completed');
assert.equal(activity.history().filter(event => event.severity === 'warning').length,1,
  'optional history failure warns once without undoing or recursively journaling the verified manifest');
await repository.appendJournal('synthetic-chat',{event:'turn.timing.completed',details:{operationId:saved.operationId,
  preprocessMs:90000,totalReplyMs:95000,firstVisibleTokenMs:null,response:'PRIVATE_CANARY'}});
const joined = (await repository.loadRunJournal('synthetic-chat')).operationSummaries[0];
assert.equal(joined.turnTiming.preprocessMs,90000,'timing events join the retained operation ID');
assert.equal(joined.turnTiming.firstVisibleTokenMs,null);
await repository.appendJournal('synthetic-chat',{event:'turn.timing.prepared',details:{operationId:saved.operationId,
  preprocessMs:90000,firstVisibleTokenMs:null}});
assert.equal((await repository.loadRunJournal('synthetic-chat')).operationSummaries[0].turnTiming.totalReplyMs,95000,
  'a late partial timing event cannot erase an already observed completion');
for (let i = 0; i < 21; i++) await repository.savePipelineRun('synthetic-chat',{...manifest(`retained-${i}`),state:'completed'});
const twenty = (await repository.loadRunJournal('synthetic-chat')).operationSummaries;
assert.equal(twenty.length,20);
assert.equal(twenty[0].operationId,'retained-1');
await repository.appendJournal('synthetic-chat',{event:'turn.timing.completed',details:{operationId:saved.operationId,preprocessMs:1}});
assert.equal((await repository.loadRunJournal('synthetic-chat')).operationSummaries.length,20);
assert(!(await repository.loadRunJournal('synthetic-chat')).operationSummaries.some(item=>item.operationId === saved.operationId),
  'late timing cannot resurrect evicted history');
await repository.savePipelineRun('another-chat',{...manifest('retained-20','another-chat'),state:'completed'});
await repository.appendJournal('another-chat',{event:'turn.timing.completed',details:{operationId:'retained-20',preprocessMs:77}});
assert.equal((await repository.loadRunJournal('synthetic-chat')).operationSummaries.at(-1).turnTiming.preprocessMs,null);
assert.equal((await repository.loadRunJournal('another-chat')).operationSummaries[0].turnTiming.preprocessMs,77);
await repository.clearRunJournal('synthetic-chat');
assert.equal((await repository.loadRunJournal('synthetic-chat')).operationSummaries.length,0);
assert.equal((await repository.loadRunJournal('synthetic-chat')).entries.length,0);
assert.equal((await repository.loadRunJournal('another-chat')).operationSummaries.length,1);
const family = CARD_SCOPE_CATALOG[0].family;
const fused = buildOperationSummary({...manifest(),stageRecords:{'preprocess.cards.fused':{
  stageId:'preprocess.cards.fused',state:'completed',kind:'model',summary:{rejections:[
    {family,code:'hidden-content',prompt:'PRIVATE_CANARY'},{family:'PRIVATE_CANARY',code:'private-claim'}]}}}});
assert.deepEqual(fused.stages[0].fused?.rejections,[{family,code:'hidden-content'}],
  'accepted Fused salvage retains fixed semantic rejection causes');
const shortfall = buildOperationSummary({...manifest(),state:'completed',stageRecords:{'preprocess.hand':{
  stageId:'preprocess.hand',state:'completed',summary:{targetCount:3,selectedCount:3,cardCount:2,omittedCount:1},
  recoveryCounts:{optionalOmissions:1}}}});
assert.equal(shortfall.counts.selectedCards,3,'selected and delivered counts remain distinct');
assert.equal(shortfall.counts.deliveredCards,2);
assert.equal(shortfall.outcome,'completed-with-omissions');
console.log('[pass] operation history');
