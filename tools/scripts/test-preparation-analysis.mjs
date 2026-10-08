import assert from 'node:assert/strict';
import { analyzePreparationReports } from './lib/preparation-analysis.mjs';
import { buildDiagnosticsPayload } from '../../src/runtime/diagnostics.mjs';

const build = {status:'declared',schema:'recursion.buildInfo.v1',version:'0.3.0-beta.1',sourceRevision:'a'.repeat(40),
  dirty:false,productionHash:'b'.repeat(64),createdAt:'2026-10-07T12:00:00.000Z'};
const configuration={mode:'auto',cardsPerTurn:6,reasoningLevel:'medium',reasonerUse:'auto',settingsHash:'abcdef01',providerHash:'12345678'};
const sample={operationId:'complete',phase:'preprocess',state:'completed',outcome:'completed',pipelineMode:'fused',lane:'utility',
  firstObservedBuild:build,latestBuild:build,configuration,stageCount:2,totalAttempts:3,
  recoveryCounts:{correctionRequests:1,parseFailures:1,optionalOmissions:0,requiredBlocks:0},
  counts:{targetCards:6,selectedCards:6,deliveredCards:6,omittedCards:0,requiredBlocks:0},
  turnTiming:{preprocessMs:100000,firstVisibleTokenMs:null},
  stages:[{stageId:'a',kind:'model',state:'completed',attemptCount:2,
    attempts:[{attempt:1,outcome:'rejected',code:'RECURSION_JSON_PARSE_FAILED',timings:{providerMs:80000}}]},
  {stageId:'b',kind:'model',state:'completed',attemptCount:1,attempts:[{attempt:1,outcome:'accepted',timings:{providerMs:60000}}]}]};
const report=analyzePreparationReports([{operationSummaries:[sample,
  {...sample,operationId:'interrupted',state:'paused',outcome:'interrupted',turnTiming:{preprocessMs:500}},
  {...sample,operationId:'missing',turnTiming:{} }],prompt:'PRIVATE_CANARY'}]);
assert.equal(report.groups.length,1);
assert.equal(report.groups[0].preparation.samples,1,'paused and missing-timing work are not completed latency samples');
assert.equal(report.groups[0].preparation.medianMs,100000,'elapsed preparation is not a sum of overlapping provider durations');
assert.equal(report.groups[0].firstVisibleToken.samples,0);
assert.equal(report.groups[0].firstVisibleToken.medianMs,null,'unknown timing is not zero');
assert.equal(report.groups[0].calls.median,3);
assert.equal(report.groups[0].corrections.median,1);
assert(!JSON.stringify(report).includes('PRIVATE_CANARY'));
console.log('[pass] preparation elapsed analysis');

const grouped=analyzePreparationReports([{operationSummaries:[sample,
  {...sample,operationId:'nine',configuration:{...configuration,cardsPerTurn:9,reasoningLevel:'high',reasonerUse:'always'}},
  {...sample,operationId:'mixed',latestBuild:{...build,productionHash:'c'.repeat(64)}},
  {...sample,operationId:'unknown-build',firstObservedBuild:{status:'unavailable'}},
  {...sample,operationId:'unknown-config',configuration:undefined,turnTiming:{preprocessMs:-1,firstVisibleTokenMs:'0'}}]}]);
assert.equal(grouped.groups.length,5,'build/routing/target and unavailable configurations are separated');
assert(grouped.groups.some(group=>group.build.status==='mixed'));
assert(grouped.groups.some(group=>group.build.status==='unavailable'));
const unknown=grouped.groups.find(group=>group.configuration.cardsPerTurn===null);
assert.equal(unknown.preparation.samples,0);
assert.equal(unknown.firstVisibleToken.samples,0);
const diagnostics = chatKey => buildDiagnosticsPayload({journal:{chatKey,operationSummaries:[sample]}});
const sameChat = analyzePreparationReports([diagnostics('synthetic'),diagnostics('synthetic')]);
assert.equal(sameChat.operations,1,'overlapping actual diagnostics exports are deduplicated');
assert.equal(sameChat.groups[0].preparation.samples,1,'re-exporting one operation cannot increase the sample count');
assert.equal(analyzePreparationReports([diagnostics('first'),diagnostics('second')]).operations,2,
  'different chats do not deduplicate');
assert.equal(analyzePreparationReports([diagnostics(''),diagnostics('')]).operations,2,
  'unavailable chat scopes cannot merge independent exports');
assert.equal(analyzePreparationReports([diagnostics('report-1'),diagnostics('')]).operations,2,
  'an actual chat key cannot collide with an unavailable scope');
const truncated=analyzePreparationReports([{operationSummaries:[{...sample,stageCount:33,
  recoveryCounts:undefined,counts:undefined,stages:[{...sample.stages[0],payload:'PRIVATE_CANARY',
    attempts:[{attempt:1,outcome:'rejected',code:'PRIVATE_CANARY',timings:{providerMs:null},message:'PRIVATE_CANARY'}]}]}]}]).groups[0];
assert.equal(truncated.calls.samples,0,'truncated stage history cannot claim total model calls');
assert.equal(truncated.corrections.samples,0,'missing counters stay unavailable');
assert.equal(truncated.cards.deliveredCards.samples,0);
assert.equal(truncated.retainedAttemptTiming.provider.samples,0);
assert(!JSON.stringify(truncated).includes('PRIVATE_CANARY'));

const {parseLiveBenchmarkOptions}=await import('./lib/live-benchmark-options.mjs');
const environment={RECURSION_SILLYTAVERN_USER:'recursion-soak-benchmark',SILLYTAVERN_BASE_URL:'http://127.0.0.1:8000'};
assert.throws(()=>parseLiveBenchmarkOptions(['--live'],{...environment,RECURSION_SILLYTAVERN_USER:'default-user'}));
assert.throws(()=>parseLiveBenchmarkOptions(['--live'],environment),'profile and sample count are required');
const options=parseLiveBenchmarkOptions(['--live','--profile','Explicit test profile','--samples','2'],environment);
assert.equal(options.samples,2);
assert.equal(options.profileName,'Explicit test profile');
assert.equal(parseLiveBenchmarkOptions(['--live','--profile','Test','--samples','1','--reasoning-level','low'],environment).reasoningLevel,'low');
for(const samples of ['0','11','1.5','abc','']) assert.throws(()=>parseLiveBenchmarkOptions(
  ['--live','--profile','Test','--samples',samples],environment));
assert.throws(()=>parseLiveBenchmarkOptions(['--profile','Test','--samples','1'],environment),'paid mode must be explicit');
console.log('[pass] preparation comparison and live input guards');

const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises');
const {tmpdir}=await import('node:os');
const {join,resolve,sep}=await import('node:path');
const {spawnSync}=await import('node:child_process');
const {fileURLToPath}=await import('node:url');
const {runPreparationAnalysis}=await import('./analyze-preparation.mjs');
const workspace=await mkdtemp(join(tmpdir(),'recursion-preparation-analysis-'));
try {
  await writeFile(join(workspace,'export.json'),JSON.stringify(diagnostics('PRIVATE_CANARY')));
  const result=await runPreparationAnalysis(['export.json'],{workspaceRoot:workspace});
  assert.equal(result.analysis.operations,1);
  assert(!String(await readFile(result.output)).includes('PRIVATE_CANARY'));
  await assert.rejects(runPreparationAnalysis(['export.json','--output','../outside.json'],{workspaceRoot:workspace}));
  await assert.rejects(runPreparationAnalysis(['export.json','--output','src/report.json'],{workspaceRoot:workspace}));
  await writeFile(join(workspace,'package.json'),'production-sentinel');
  for (const output of ['PACKAGE.JSON','Manifest.JSON','Package-Lock.Json','Src/report.json','Styles/report.json',
    'Assets/report.json','.GIT/report.json']) {
    await assert.rejects(runPreparationAnalysis(['export.json','--output',output],{workspaceRoot:workspace}),
      /outside production files/,output+' cannot bypass protected output paths');
  }
  assert.equal(await readFile(join(workspace,'package.json'),'utf8'),'production-sentinel');
  await writeFile(join(workspace,'broken.json'),'private invalid input');
  await assert.rejects(runPreparationAnalysis(['broken.json'],{workspaceRoot:workspace}),/bounded JSON diagnostics export/);
} finally {
  assert(resolve(workspace).startsWith(resolve(tmpdir())+sep+'recursion-preparation-analysis-'));
  await rm(workspace,{recursive:true,force:true});
}
const guarded=spawnSync(process.execPath,[fileURLToPath(new URL('./benchmark-preprocess-latency.mjs',import.meta.url)),'--live'],
  {encoding:'utf8',timeout:5000,env:{...process.env,...environment,RECURSION_SILLYTAVERN_USER:'default-user'}});
assert.notEqual(guarded.status,0);
assert.match(guarded.stderr,/Default User is rejected/);
assert(!guarded.stderr.includes('Cannot find package') && !guarded.stderr.includes('browserType.launch'),
  'unsafe paid inputs are rejected before loading browser/session code');
console.log('[pass] read-only analysis CLI and benchmark entry guard');
