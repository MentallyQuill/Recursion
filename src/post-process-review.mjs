import { hashJson, makeId } from './core.mjs';
import { POST_PROCESS_COMPARISON_SCHEMA } from './post-process-comparison.mjs';

const copy = (value) => JSON.parse(JSON.stringify(value));
export function postProcessSnapshotIdentity(snapshot) {
  return { chatIdentityHash: snapshot.chatIdentityHash, messageId: snapshot.sourceMessageId,
    swipeId: snapshot.sourceSwipeId, sourceTextHash: snapshot.sourceHash,
    activeCharacterHash: snapshot.activeCharacterHash, activeGroupHash: snapshot.activeGroupHash };
}
export function postProcessIdentityMatches(actual, expected) {
  return Boolean(actual && expected && actual.chatIdentityHash === expected.chatIdentityHash
    && Number(actual.messageId) === Number(expected.messageId)
    && Number(actual.swipeId ?? 0) === Number(expected.swipeId ?? 0)
    && (actual.originalHash || actual.sourceTextHash) === expected.sourceTextHash
    && String(actual.activeCharacterHash || '') === String(expected.activeCharacterHash || '')
    && String(actual.activeGroupHash || '') === String(expected.activeGroupHash || ''));
}
const targetIdentity = (actual) => ({ chatIdentityHash: actual.chatIdentityHash,
  messageId: actual.messageId, swipeId: actual.swipeId ?? 0,
  sourceTextHash: actual.originalHash || actual.sourceTextHash,
  activeCharacterHash: actual.activeCharacterHash || '', activeGroupHash: actual.activeGroupHash || '' });

export function createPostProcessReview({
  repository, getChatKey, readIdentity, checkContext = async () => true,
  commit, restore, retry, reconcile, reconcileRestore, onChange = () => {}
}) {
  let tail = Promise.resolve();
  const controllers = new Set();
  const canceled = (signal) => {
    if (signal?.aborted) throw Object.assign(new Error('Revision action canceled.'), {code:'RECURSION_POST_PROCESS_CANCELED'});
  };
  const cancel = (reason = 'canceled') => {
    const canceled = controllers.size > 0;
    for (const controller of controllers) controller.abort(reason);
    return {ok:true,canceled};
  };
  const serial = (run) => {
    const result = tail.catch(() => {}).then(run);
    tail = result;
    return result;
  };
  async function eligible(record) {
    return !['stale', 'rejected'].includes(record.state)
      && await checkContext(record)
      && postProcessIdentityMatches(await readIdentity(), record.targetIdentity);
  }
  async function save(record) {
    const result = await repository.savePostProcessComparison(record.chatKey, {
      ...record, updatedAt: new Date().toISOString()
    });
    try { onChange(); } catch { /* Observers cannot undo persistence. */ }
    return result;
  }
  function commitInput(record, signal) {
    const finalArtifactHash = hashJson(record.candidateText);
    const operationId = record.revisionId;
    return {
      operationId, commitId: hashJson({operationId, finalArtifactHash}), finalArtifactHash,
      sourceMessageId: record.targetIdentity.messageId, sourceSwipeId: record.targetIdentity.swipeId,
      sourceHash: record.targetIdentity.sourceTextHash, sourceIdentity: copy(record.targetIdentity),
      expectedSourceIdentity: copy(record.targetIdentity), snapshotHash: record.originalSnapshot.snapshotHash,
      text: record.candidateText, mode: record.applyMode, markerNamespace: 'postProcess', signal,
      marker: { schema:'recursion.postProcessMarker.v1', operationId,
        comparisonId:record.id, revisionId:record.revisionId, sourceHash:record.targetIdentity.sourceTextHash,
        candidateHash:finalArtifactHash, editingScope:record.editingScope, manualEdit:record.manualEdit,
        requestedApplyMode:record.applyMode, committedApplyMode:record.applyMode,
        partial:false, categories:[] }
    };
  }
  async function reconcileRecord(record) {
    if (['stale','rejected'].includes(record.state) || !await checkContext(record)) return record;
    if (typeof reconcileRestore === 'function') {
      const restored = await reconcileRestore({operationId:record.operationId,revisionId:record.revisionId,
        expectedSourceIdentity:record.targetIdentity,originalSnapshot:record.originalSnapshot});
      if (restored && postProcessIdentityMatches(await readIdentity(),targetIdentity(restored.identity))) {
        return save({...record,state:'rejected',targetIdentity:targetIdentity(restored.identity),retryInputs:null});
      }
    }
    if (record.state !== 'pending' || typeof reconcile !== 'function') return record;
    const receipt = await reconcile(commitInput(record));
    if (!receipt || receipt.finalArtifactHash !== record.candidateHash) return record;
    const identity = await readIdentity();
    const expected = {...record.targetIdentity,messageId:receipt.targetMessageId,
      swipeId:receipt.targetSwipeId,sourceTextHash:record.candidateHash};
    if (!postProcessIdentityMatches(identity,expected)) return record;
    return save({...record,state:'applied',receipt,targetIdentity:targetIdentity(identity)});
  }
  async function apply(record, signal) {
    canceled(signal);
    record = await reconcileRecord(record);
    if (!await eligible(record)) return {ok:false,reason:'stale-source',comparison:record};
    if (record.state === 'applied') return {ok:true,reason:'already-applied',comparison:record};
    canceled(signal);
    const result = await commit(commitInput(record, signal));
    if (result?.ok !== true) return {ok:false,reason:result?.error?.code || 'commit-failed',comparison:record};
    const identity = await readIdentity();
    const expected = {...record.targetIdentity,sourceTextHash:record.candidateHash,
      swipeId:result.receipt?.targetSwipeId ?? identity?.swipeId};
    if (!postProcessIdentityMatches(identity,expected)) return {ok:false,reason:'stale-source',comparison:record};
    const applied = await save({...record,state:'applied',receipt:result.receipt || null,
      targetIdentity: targetIdentity(identity)});
    return {ok:true,applied:result?.applied !== false,reason:result.reason || 'applied',comparison:applied};
  }
  return {
    cancel,
    waitForSettlement: () => tail.catch(() => {}),
    isRunning: () => controllers.size > 0,
    invalidate({chatKey,clear=false,sourceMessageId,expectedChatIdentityHash} = {}) {
      cancel('source-changed');
      return serial(async()=>{
        const key = chatKey || await getChatKey();
        const records = await repository.listPostProcessComparisons(key);
        for (const record of records) {
          if (expectedChatIdentityHash && record.originalSnapshot.chatIdentityHash !== expectedChatIdentityHash) continue;
          if (sourceMessageId !== undefined && Number(record.originalSnapshot.sourceMessageId) !== Number(sourceMessageId)) continue;
          if (clear) await repository.deletePostProcessComparison(key,record.id);
          else if (!['stale','rejected'].includes(record.state)) await save({...record,state:'stale',retryInputs:null});
        }
        try { onChange(); } catch {}
        return {ok:true};
      });
    },
    async stage({operation,text,retryInputs=null}) {
      canceled(operation.signal);
      const record = await save({
        schema:POST_PROCESS_COMPARISON_SCHEMA,id:operation.comparisonId || operation.operationId,
        operationId:operation.operationId, revisionId:operation.operationId,chatKey:operation.snapshot.chatKey,
        originalSnapshot:copy(operation.snapshot),candidateText:text,candidateHash:hashJson(text),
        targetIdentity:copy(operation.commitTargetIdentity || postProcessSnapshotIdentity(operation.snapshot)),
        writer:copy(operation.writer),editingScope:operation.editingScope,applyMode:operation.applyMode,
        state:'pending',retryInputs,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()
      });
      if (operation.signal?.aborted) {
        await save({...record,state:'stale',retryInputs:null});
        canceled(operation.signal);
      }
      if (operation.reviewBeforeApplying) return {ok:true,applied:false,reason:'awaiting-review',comparison:record};
      return serial(()=>apply(record,operation.signal));
    },
    list() {
      return serial(async()=>{
        const records = await repository.listPostProcessComparisons(await getChatKey());
        return Promise.all(records.map(async (stored)=>{
          let record = await reconcileRecord(stored);
          const current = await eligible(record);
          if (!current && !['stale','rejected'].includes(record.state)) record = await save({...record,state:'stale',retryInputs:null});
          return {...record,eligible:current,
            ineligibleReason:current ? '' : 'The source response or conversation has changed.'};
        }));
      });
    },
    act({id,action,text}) {
      const controller = new AbortController();
      controllers.add(controller);
      const signal = controller.signal;
      return serial(async()=>{
        canceled(signal);
        let record = await repository.loadPostProcessComparison(await getChatKey(),id);
        if (!record) return {ok:false,reason:'comparison-unavailable'};
        record = await reconcileRecord(record);
        if (action === 'keep' && record.state === 'rejected') return {ok:true,reason:'kept-original',comparison:record};
        if (action === 'apply') return apply(record,signal);
        const current = await eligible(record);
        if (!current && !(action === 'keep' && !['stale','rejected'].includes(record.state)
            && await checkContext(record))) return {ok:false,reason:'stale-source',comparison:record};
        canceled(signal);
        if (action === 'retry') {
          if (!record.retryInputs || typeof retry !== 'function') return {ok:false,reason:'retry-unavailable',comparison:record};
          const result = await retry(record,{signal});
          canceled(signal);
          const updated = await repository.loadPostProcessComparison(record.chatKey,record.id);
          return {...result,ok:result?.ok === true,comparison:updated || record};
        }
        if (action === 'keep') {
          let identity = await readIdentity();
          if (!current || !postProcessIdentityMatches(identity,postProcessSnapshotIdentity(record.originalSnapshot))) {
            if (typeof restore !== 'function') return {ok:false,reason:'restore-unavailable',comparison:record};
            const result = await restore({mode:record.applyMode,originalSnapshot:record.originalSnapshot,
              expectedSourceIdentity:record.targetIdentity,operationId:record.operationId,revisionId:record.revisionId,signal});
            if (result?.ok !== true) return {ok:false,reason:result?.error?.code || result?.reason || 'restore-failed',comparison:record};
            identity = result.identity || await readIdentity();
          }
          const kept = await save({...record,state:'rejected',targetIdentity:targetIdentity(identity),retryInputs:null});
          return {ok:true,reason:'kept-original',comparison:kept};
        }
        if (action === 'edit') {
          if (typeof text !== 'string' || !text.trim()) return {ok:false,reason:'empty-candidate',comparison:record};
          const edited = await save({...record,candidateText:text,candidateHash:hashJson(text),
            revisionId:makeId('post-process-edit'),receipt:null,state:'pending',manualEdit:true});
          return {ok:true,reason:'edited',comparison:edited};
        }
        return {ok:false,reason:'unknown-action',comparison:record};
      }).catch(error=>({ok:false,reason:error?.code || 'review-failed',error:{message:error?.message || 'Revision action failed.'}}))
        .finally(()=>controllers.delete(controller));
    }
  };
}
