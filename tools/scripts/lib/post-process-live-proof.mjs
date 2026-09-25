// Report only machine identifiers, counts, and hashes; never narrative or provider responses.
const token = value => /^[A-Za-z0-9_.:/-]{1,180}$/.test(String(value || '')) ? String(value) : '';
export function checkLoadedIdentity(urls, baseUrl) {
  const root = new URL('/scripts/extensions/third-party/Recursion/', baseUrl).href;
  const loaded = [...new Set(urls.map(value => { try { const url = new URL(value); return url.origin + url.pathname; } catch { return ''; } }))];
  const recursion = loaded.filter(value => /\/extensions\/third-party\/[^/]*recursion[^/]*\//i.test(value));
  const unexpected = recursion.filter(value => !value.startsWith(root));
  const entrypoint = loaded.includes(`${root}src/extension/index.js`);
  const runtime = loaded.includes(`${root}src/runtime.mjs`);
  return { ok: entrypoint && runtime && unexpected.length === 0, entrypoint, runtime, unexpected: unexpected.map(value => new URL(value).pathname), root };
}
export function parseCases(value = 'generation-auto,swipe-auto,generation-review,swipe-review') {
  const cases = [...new Set(String(value).split(',').map(item => item.trim()))];
  if (!cases.length || cases.some(item => !['generation-auto','swipe-auto','generation-review','swipe-review'].includes(item))) throw new Error('Unknown live proof case.');
  return cases;
}
export function caseOutcome({ before, after, scenario }) {
  const diagnostic = after.diagnostics || {};
  const execution = after.execution || {};
  const freshDiagnostic = diagnostic.operationId && diagnostic.operationId !== before.diagnosticOperationId;
  const freshExecution = execution.operationId && execution.operationId !== before.executionOperationId;
  if (freshExecution && ['paused','failed','canceled','cancelled','stale'].includes(execution.state)) {
    return {status:'fail', reason:`${token(execution.phase) || 'execution'}-${token(execution.state)}`};
  }
  if (after.postProcessPending || after.postProcessRunning || after.hostGenerationActive) return {status:'wait'};
  if (!freshDiagnostic) return {status:'wait'};
  if (diagnostic.status === 'awaiting-review' && scenario.endsWith('-review') && after.pendingComparisons?.length === 1) return {status:'review'};
  if (['failed','skipped','canceled','paused','stale','no-change'].includes(diagnostic.status)) return {status:'fail',reason:`post-process-${diagnostic.status}`};
  if (diagnostic.status !== 'applied') return {status:'wait'};
  const expectedCount = scenario.startsWith('swipe-') ? before.swipeCount + 2 : 2;
  const freshMessage = scenario.startsWith('swipe-') ? after.messageId === before.messageId : after.messageId > before.messageId;
  return freshMessage && after.swipeCount === expectedCount && after.swipeId === expectedCount - 1 && after.swipeInfoLength === expectedCount && after.markerValid
    ? {status:'pass'} : {status:'fail',reason:'post-process-swipe-invalid'};
}
export function safeEvidence(value = {}) {
  const diagnostics = value.diagnostics || {};
  const execution = value.execution || {};
  const stage = item => ({id:token(item.stageId || item.id),status:token(item.status || item.state),code:token(item.failure?.code || item.failureCode || item.error?.code || item.lastError?.code || item.code),failureStage:token(item.failureStage)});
  return {
    ...Object.fromEntries(['messageId','index','swipeId','swipeCount','swipeInfoLength','messageCount'].filter(key => Number.isFinite(value[key])).map(key => [key,value[key]])),
    ...Object.fromEntries(['markerValid','postProcessPending','postProcessRunning','hostGenerationActive','nativeStopVisible'].map(key => [key,value[key] === true])),
    markerSchema:token(value.markerSchema),markerSourceHash:token(value.markerSourceHash),markerCandidateHash:token(value.markerCandidateHash),
    diagnostics:{operationId:token(diagnostics.operationId),status:token(diagnostics.status),failure:stage(diagnostics.failure || {}),reason:token(diagnostics.reason),categories:(diagnostics.categories || []).slice(0,32).map(stage)},
    execution:{operationId:token(execution.operationId),phase:token(execution.phase),state:token(execution.state),pauseReason:token(execution.pauseReason),stages:(execution.stages || []).slice(0,64).map(stage)},
    pendingComparisons:(value.pendingComparisons || []).slice(0,8).map(item => ({id:token(item.id),state:token(item.state),eligible:item.eligible === true}))
  };
}
export async function withDeadline(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Live proof reached its deadline.'), {result:'case-deadline'})), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
export async function waitForNativeConnection(read, {timeoutMs=15000, intervalMs=500} = {}) {
  const deadline=Date.now()+timeoutMs;
  let result=await read();
  while (result.native?.connected === false && Date.now()<deadline) {
    await new Promise(done=>setTimeout(done,Math.min(intervalMs,Math.max(1,deadline-Date.now()))));
    result=await read();
  }
  return result;
}
