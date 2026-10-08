import { normalizeOperationSummaries } from '../../../src/storage/operation-history.mjs';

const completed = new Set(['completed','completed-with-omissions']);
const measured = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
function statistics(values, duration = false) {
  const sorted=values.map(measured).filter(value=>value !== null).sort((a,b)=>a-b);
  const middle=Math.floor(sorted.length/2);
  const median=sorted.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2 : null;
  return duration ? {samples:sorted.length,medianMs:median,minMs:sorted[0] ?? null,maxMs:sorted.at(-1) ?? null}
    : {samples:sorted.length,median,min:sorted[0] ?? null,max:sorted.at(-1) ?? null};
}
function buildGroup(summary) {
  const first=summary.firstObservedBuild,latest=summary.latestBuild;
  if(first.status !== 'declared' || latest.status !== 'declared') return {status:'unavailable',
    firstStatus:first.status,latestStatus:latest.status,firstHash:first.productionHash ?? null,latestHash:latest.productionHash ?? null};
  if(first.productionHash !== latest.productionHash || first.dirty !== latest.dirty) return {status:'mixed',
    firstHash:first.productionHash,latestHash:latest.productionHash};
  return {status:'declared',productionHash:latest.productionHash,dirty:latest.dirty};
}

// Only normalized operation summaries are consumed. Story/chat identifiers are
// used for deduplication internally and never become report fields.
export function analyzePreparationReports(reports = []) {
  const operations=new Map();
  for(const [reportIndex,report] of (Array.isArray(reports) ? reports : []).entries()) {
    const raw=Array.isArray(report?.operationSummaries) ? report.operationSummaries : [];
    for(const summary of normalizeOperationSummaries(raw)) {
      if(summary.phase !== 'preprocess') continue;
      const original=raw.findLast(value=>value?.operationId === summary.operationId) || {};
      const scope=typeof report.chatKey === 'string' ? report.chatKey : `report-${reportIndex}`;
      const key=JSON.stringify([scope,summary.operationId]);
      const prior=operations.get(key);
      if(prior?.summary.updatedAt && summary.updatedAt && prior.summary.updatedAt > summary.updatedAt) continue;
      operations.set(key,{summary,original});
    }
  }
  const groups=new Map();
  for(const value of operations.values()) {
    const {summary}=value;
    const identity={build:buildGroup(summary),configuration:summary.configuration,
      pipelineMode:summary.pipelineMode,lane:summary.lane};
    const key=JSON.stringify(identity);
    if(!groups.has(key)) groups.set(key,{identity,operations:[]});
    groups.get(key).operations.push(value);
  }
  const result=[];
  for(const {identity,operations:values} of groups.values()) {
    const finished=values.filter(({summary})=>completed.has(summary.outcome));
    const outcomeCounts={};
    const retainedFailureCodes={};
    const queueMs=[],providerMs=[];
    for(const {summary} of values) {
      outcomeCounts[summary.outcome]=(outcomeCounts[summary.outcome] || 0)+1;
      for(const stage of summary.stages) for(const attempt of stage.attempts) {
        if(attempt.code) retainedFailureCodes[attempt.code]=(retainedFailureCodes[attempt.code] || 0)+1;
        queueMs.push(attempt.timings.queueMs); providerMs.push(attempt.timings.providerMs);
      }
    }
    result.push({...identity,operations:values.length,outcomeCounts,
      preparation:statistics(finished.map(({original})=>original.turnTiming?.preprocessMs),true),
      firstVisibleToken:statistics(finished.map(({original})=>original.turnTiming?.firstVisibleTokenMs),true),
      totalReply:statistics(finished.map(({original})=>original.turnTiming?.totalReplyMs),true),
      calls:statistics(values.map(({summary,original})=> measured(original.stageCount) === summary.stages.length
        && summary.stages.every((stage,index)=>['model','local','validation-outcome'].includes(stage.kind)
          && measured(original.stages?.[index]?.attemptCount) !== null)
        ? summary.stages.filter(stage=>stage.kind === 'model').reduce((sum,stage)=>sum+stage.attemptCount,0) : null)),
      corrections:statistics(values.map(({original})=>original.recoveryCounts?.correctionRequests)),
      omissions:statistics(values.map(({original})=>original.recoveryCounts?.optionalOmissions)),
      requiredBlocks:statistics(values.map(({original})=>original.recoveryCounts?.requiredBlocks)),
      cards:Object.fromEntries(['targetCards','selectedCards','deliveredCards','omittedCards']
        .map(key=>[key,statistics(values.map(({original})=>original.counts?.[key]))])),
      retainedAttemptTiming:{queue:statistics(queueMs,true),provider:statistics(providerMs,true)},retainedFailureCodes});
  }
  return {schema:'recursion.preparationAnalysis.v1',sourceReports:Array.isArray(reports) ? reports.length : 0,
    operations:operations.size,groups:result.sort((a,b)=>JSON.stringify(a.configuration).localeCompare(JSON.stringify(b.configuration)))};
}
