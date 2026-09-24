import { makeId } from '../core.mjs';
import {
  createCheckpoint,
  createStageRecord,
  isCheckpointReusable,
  isTerminalOperationState,
  normalizePipelineRun,
  normalizeStageRecord
} from './checkpoints.mjs';
import { runModelStageAttempts } from './attempt-policy.mjs';
import { normalizeOperationBudget, reserveRecoveryCall, remainingExecutionMs, settleOperationClock } from './operation-budget.mjs';

const POST_PROCESS_RECOVERY_LIMIT = 2;

const MODEL_RETRY_ACTIONS = new Set([
  'stop',
  'downgrade-structured-output',
  'increase-output-budget',
  'reduce-output-budget',
  'retry-corrected',
  'retry-same'
]);
import {
  compareRunProvenance,
  normalizeExecutionProvenance,
  stableHash
} from './provenance.mjs';
import { consumeQueuedStageStart } from './queued-reprocess.mjs';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function normalizeAttemptLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 2;
  return Math.min(5, Math.max(1, parsed));
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asValidationResult(result, artifact) {
  if (result === true || result === undefined) return { ok: true, value: artifact };
  if (result === false) {
    return {
      ok: false,
      error: { code: 'RECURSION_STAGE_ARTIFACT_INVALID' }
    };
  }
  if (result?.ok === true) {
    return {
      ok: true,
      value: result.value === undefined ? artifact : result.value
    };
  }
  if (result?.ok === false) return result;
  return { ok: true, value: result };
}

function failureRecord(failure, fallbackCode = 'RECURSION_STAGE_FAILED') {
  const source = isObject(failure) ? failure : {};
  const message = String(source.message || '').trim().slice(0, 300);
  const suggestedAction = String(source.suggestedAction || '').trim().slice(0, 180);
  return {
    code: String(source.code || fallbackCode).slice(0, 120),
    failureClass: String(source.category || source.kind || 'internal').slice(0, 80),
    retryable: source.retryable === true,
    ...(message ? { message } : {}),
    ...(suggestedAction ? { suggestedAction } : {})
  };
}

function abortFailure() {
  const error = new Error('Execution stage was stopped.');
  error.name = 'AbortError';
  error.code = 'RECURSION_MODEL_ATTEMPT_ABORTED';
  return error;
}

async function raceAbort(operation, signal) {
  if (signal?.aborted) throw abortFailure();
  let removeListener = () => {};
  const abortPromise = signal
    ? new Promise((_, reject) => {
        const onAbort = () => reject(abortFailure());
        signal.addEventListener('abort', onAbort, { once: true });
        removeListener = () => signal.removeEventListener('abort', onAbort);
      })
    : null;
  try {
    const running = Promise.resolve().then(operation);
    return await Promise.race(abortPromise ? [running, abortPromise] : [running]);
  } finally {
    removeListener();
  }
}

function graphStageRecords(manifest, graph, attemptsLimit, updatedAt) {
  const existing = manifest.stageRecords || {};
  return Object.fromEntries(graph.topologicalStageIds.map((stageId) => {
    const stage = graph.getStage(stageId);
    const current = normalizeStageRecord(existing[stageId]);
    if (
      current
      && current.stageVersion === stage.version
      && current.kind === stage.kind
    ) {
      return [stageId, current];
    }
    return [stageId, createStageRecord({
      stageId,
      stageVersion: stage.version,
      kind: stage.kind,
      attemptsLimit,
      updatedAt
    })];
  }));
}

function removeValue(values, target) {
  return (Array.isArray(values) ? values : []).filter((value) => value !== target);
}

function dependencyHash(value) {
  return String(value?.checkpoint?.outputHash || value?.stateHash || '');
}

export function createExecutionScheduler({
  repository,
  now = () => new Date().toISOString(),
  createId = makeId,
  attemptsPerStep = 2,
  onViewChanged = null
} = {}) {
  for (const method of [
    'loadPipelineRun',
    'savePipelineRun',
    'loadPipelineArtifact',
    'savePipelineArtifact'
  ]) {
    if (typeof repository?.[method] !== 'function') {
      throw new TypeError(`Execution scheduler repository requires ${method}.`);
    }
  }

  const operations = new Map();
  const operationByChat = new Map();
  const resumeTransitions = new Map();

  function attemptLimit() {
    return normalizeAttemptLimit(
      typeof attemptsPerStep === 'function' ? attemptsPerStep() : attemptsPerStep
    );
  }

  function publish(runtime) {
    if (typeof onViewChanged !== 'function') return;
    try {
      onViewChanged(clone(runtime.manifest));
    } catch {
      // View projection is advisory and cannot break persistence.
    }
  }

  async function saveStandalone(manifest, changes = {}) {
    const normalized = normalizePipelineRun({
      ...manifest,
      ...changes,
      revision: Number(manifest.revision || 0) + 1,
      updatedAt: now()
    });
    if (!normalized) throw new TypeError('Pipeline manifest is invalid.');
    return repository.savePipelineRun(normalized.chatKey, normalized);
  }

  function queueMutation(runtime, updater, { verifyStored = true } = {}) {
    const mutation = runtime.mutationTail.then(async () => {
      const current = runtime.manifest;
      if (verifyStored) {
        const stored = await repository.loadPipelineRun(current.chatKey);
        if (
          stored
          && (
            stored.operationId !== current.operationId
            || Number(stored.revision || 0) !== Number(current.revision || 0)
          )
        ) {
          throw new Error('Pipeline manifest revision changed outside the active scheduler.');
        }
      }
      const draft = clone(current);
      const updated = await updater(draft);
      if (!updated) return current;
      if (updated.recoveryBudget && updated.state !== current.state) {
        updated.recoveryBudget = settleOperationClock(updated.recoveryBudget, updated.state === 'running', Date.parse(now()));
      }
      const next = normalizePipelineRun({
        ...updated,
        operationId: current.operationId,
        chatKey: current.chatKey,
        revision: Number(current.revision || 0) + 1,
        updatedAt: now()
      });
      if (!next) throw new TypeError('Pipeline manifest mutation is invalid.');
      await repository.savePipelineRun(next.chatKey, next);
      runtime.manifest = next;
      publish(runtime);
      return next;
    });
    runtime.mutationTail = mutation.catch(() => {});
    return mutation;
  }

  async function loadDependencyArtifacts(runtime, stage) {
    const dependencies = {};
    for (const dependencyId of stage.dependencies) {
      const record = runtime.manifest.stageRecords[dependencyId];
      const checkpoint = record?.checkpoint;
      const dependencyStage = runtime.graph.getStage(dependencyId);
      if (
        !checkpoint
        && record?.state === 'failed'
        && dependencyStage?.failurePolicy === 'continue'
      ) {
        const failure = clone(record.failure);
        dependencies[dependencyId] = {
          artifact: null,
          checkpoint: null,
          state: 'failed',
          failure,
          stateHash: await stableHash({
            stageId: dependencyId,
            state: 'failed',
            failure
          })
        };
        continue;
      }
      if (!checkpoint) throw new Error(`Dependency checkpoint missing for ${dependencyId}.`);
      const artifactId = checkpoint.artifactRef?.artifactId || dependencyId;
      const artifact = await repository.loadPipelineArtifact(
        runtime.manifest.chatKey,
        checkpoint.operationId,
        artifactId
      );
      if (!artifact || await stableHash(artifact) !== checkpoint.outputHash) {
        throw new Error(`Dependency artifact invalid for ${dependencyId}.`);
      }
      dependencies[dependencyId] = {
        artifact,
        checkpoint,
        state: 'completed',
        failure: null,
        stateHash: checkpoint.outputHash
      };
    }
    return dependencies;
  }

  async function validateArtifact(stage, artifact, context) {
    if (!isObject(artifact)) {
      return {
        ok: false,
        error: { code: 'RECURSION_STAGE_ARTIFACT_INVALID' }
      };
    }
    if (typeof stage.validate !== 'function') return { ok: true, value: artifact };
    try {
      return asValidationResult(await stage.validate(artifact, context), artifact);
    } catch (error) {
      return { ok: false, error };
    }
  }

  async function reusableCheckpoint(runtime, stage) {
    const record = runtime.manifest.stageRecords[stage.id];
    const checkpoint = record?.checkpoint;
    if (!checkpoint || runtime.forcedStageIds.has(stage.id)) return false;
    try {
      const dependencyArtifacts = await loadDependencyArtifacts(runtime, stage);
      const fingerprint = typeof stage.buildInputFingerprint === 'function'
        ? await stage.buildInputFingerprint(runtime.context, dependencyArtifacts)
        : {
            stageId: stage.id,
            dependencyHashes: Object.fromEntries(
              Object.entries(dependencyArtifacts).map(([stageId, value]) => [
                stageId,
                dependencyHash(value)
              ])
            )
          };
      const inputHash = await stableHash(fingerprint);
      const artifactId = checkpoint.artifactRef?.artifactId || stage.id;
      const artifact = await repository.loadPipelineArtifact(
        runtime.manifest.chatKey,
        checkpoint.operationId,
        artifactId
      );
      if (!artifact || await stableHash(artifact) !== checkpoint.outputHash) return false;
      const validation = await validateArtifact(stage, artifact, {
        context: runtime.context,
        dependencies: dependencyArtifacts,
        reuse: true
      });
      if (!validation.ok) return false;
      return isCheckpointReusable({
        checkpoint,
        stage: {
          ...stage,
          inputHash
        },
        dependencyCheckpoints: Object.fromEntries(
          Object.entries(dependencyArtifacts).map(([stageId, value]) => [
            stageId,
            value.checkpoint || { outputHash: dependencyHash(value) }
          ])
        ),
        artifactHash: checkpoint.outputHash,
        expectedProvenance: runtime.provenance
      });
    } catch {
      return false;
    }
  }

  async function canCommit(runtime, stageId, executionToken, signal) {
    if (signal.aborted || runtime.manifest.state !== 'running') return false;
    const currentRecord = runtime.manifest.stageRecords[stageId];
    if (
      currentRecord?.state !== 'running'
      || currentRecord.executionToken !== executionToken
    ) {
      return false;
    }
    const stored = await repository.loadPipelineRun(runtime.manifest.chatKey);
    return stored?.operationId === runtime.manifest.operationId
      && stored?.state === 'running'
      && stored?.stageRecords?.[stageId]?.executionToken === executionToken;
  }

  async function consumeQueuedIntent(runtime, stageId) {
    if (!runtime.queuedStageIds.has(stageId)) return;
    runtime.queuedStageIds.delete(stageId);
    if (typeof repository.loadQueuedReprocess !== 'function') return;
    const intent = await repository.loadQueuedReprocess(
      runtime.manifest.chatKey,
      runtime.manifest.phase
    );
    const consumed = consumeQueuedStageStart({ intent, stageId });
    if (!consumed.consumed) return;
    if (consumed.intent && typeof repository.saveQueuedReprocess === 'function') {
      await repository.saveQueuedReprocess(runtime.manifest.chatKey, consumed.intent);
    } else if (typeof repository.clearQueuedReprocess === 'function') {
      await repository.clearQueuedReprocess(runtime.manifest.chatKey, runtime.manifest.phase);
    }
  }

  async function failStage(runtime, stage, executionToken, failure) {
    try {
      await queueMutation(runtime, (draft) => {
        const record = draft.stageRecords[stage.id];
        if (
          !record
          || record.executionToken !== executionToken
          || record.state !== 'running'
        ) {
          return null;
        }
        draft.stageRecords[stage.id] = {
          ...record,
          state: 'failed',
          checkpoint: null,
          failure: failureRecord(failure),
          executionToken: null,
          updatedAt: now()
        };
        draft.frontierStageIds = removeValue(draft.frontierStageIds, stage.id);
        return draft;
      });
    } catch {
      // The last durably written manifest remains authoritative.
    }
  }

  async function failPendingStage(runtime, stage, failure) {
    try {
      await queueMutation(runtime, (draft) => {
        const record = draft.stageRecords[stage.id];
        if (!record || record.state !== 'pending') return null;
        draft.stageRecords[stage.id] = {
          ...record,
          state: 'failed',
          checkpoint: null,
          failure: failureRecord(failure),
          executionToken: null,
          updatedAt: now()
        };
        draft.frontierStageIds = removeValue(draft.frontierStageIds, stage.id);
        return draft;
      });
    } catch {
      // The last durably written manifest remains authoritative.
    }
  }

  async function executeStage(runtime, stage) {
    let executionToken = null;
    const queuedIntentConsumed = runtime.queuedStageIds.has(stage.id);
    const controller = new AbortController();
    runtime.controllers.set(stage.id, controller);
    let dependencyArtifacts = {};
    let inputHash = '';
    let openedAttempts = null;
    let validationMs = 0;

    try {
      executionToken = createId('stage');
      dependencyArtifacts = await loadDependencyArtifacts(runtime, stage);
      const fingerprint = typeof stage.buildInputFingerprint === 'function'
        ? await stage.buildInputFingerprint(runtime.context, dependencyArtifacts)
        : {
            stageId: stage.id,
            dependencyHashes: Object.fromEntries(
              Object.entries(dependencyArtifacts).map(([stageId, value]) => [
                stageId,
                dependencyHash(value)
              ])
            )
          };
      inputHash = await stableHash(fingerprint);
      const modelStage = stage.kind === 'model';
      const limit = modelStage ? attemptLimit() : 0;
      await queueMutation(runtime, (draft) => {
        if (draft.state !== 'running') return null;
        const record = draft.stageRecords[stage.id];
        openedAttempts = modelStage
          ? {
              window: Number(record.attempts?.window || 0) + 1,
              limit,
              used: 0,
              total: Number(record.attempts?.total || 0)
            }
          : record.attempts;
        draft.stageRecords[stage.id] = {
          ...record,
          state: 'running',
          checkpoint: null,
          summary: null,
          failure: null,
          diagnosticCodes: queuedIntentConsumed
            ? [...new Set([...(record.diagnosticCodes || []), 'stage-reprocess-consumed'])]
            : record.diagnosticCodes || [],
          attempts: openedAttempts,
          executionToken,
          startedAt: now(),
          updatedAt: now()
        };
        draft.frontierStageIds = [
          ...new Set([...draft.frontierStageIds, stage.id])
        ];
        draft.queuedStageIds = removeValue(draft.queuedStageIds, stage.id);
        return draft;
      });
      if (
        runtime.manifest.state !== 'running'
        || runtime.manifest.stageRecords[stage.id]?.executionToken !== executionToken
      ) {
        return;
      }

      runtime.forcedStageIds.delete(stage.id);
      await consumeQueuedIntent(runtime, stage.id);
      const request = typeof stage.buildRequest === 'function'
        ? await stage.buildRequest(runtime.context, dependencyArtifacts)
        : { context: runtime.context, dependencies: dependencyArtifacts };
      const invokeStage = (attemptRequest, attempt = 0) => raceAbort(
        () => stage.run({
          request: attemptRequest,
          signal: controller.signal,
          context: runtime.context,
          dependencies: dependencyArtifacts,
          attempt,
          operationId: runtime.manifest.operationId,
          stageId: stage.id
        }),
        controller.signal
      );
      let attemptResult;
      if (modelStage) {
        attemptResult = await runModelStageAttempts({
          attemptsPerStep: openedAttempts.limit,
          request,
          signal: controller.signal,
          invoke: async (attemptRequest, attemptContext) => {
            if (!runtime.manifest.recoveryBudget) return invokeStage(attemptRequest, attemptContext.attempt);
            const paidRecovery = runtime.manifest.recoveryBudget?.reservationIds.includes(`initial:${stage.id}`)
              || (stage.id.startsWith('preprocess.cards.segmented.') && Boolean(runtime.manifest.stageRecords['preprocess.cards.fused']));
            if (stage.failurePolicy === 'continue' && paidRecovery) {
              const requiredWork = runtime.graph.stages.filter((entry) =>
                entry.id.startsWith('preprocess.cards.segmented.') && entry.failurePolicy !== 'continue')
                .map((entry) => runtime.activeStagePromises.get(entry.id)).filter(Boolean);
              await raceAbort(() => Promise.allSettled(requiredWork), controller.signal);
            }
            let reservation;
            await queueMutation(runtime, (draft) => {
              if (draft.state !== 'running' || draft.stageRecords[stage.id]?.executionToken !== executionToken) return null;
              const selectedCount = Math.max(
                runtime.graph.getStage('preprocess.cards.fused')?.outcomeChildren?.length || 0,
                runtime.graph.stages.filter((entry) => entry.id.startsWith('preprocess.cards.segmented.')).length
              );
              const budget = normalizeOperationBudget(draft.recoveryBudget);
              budget.recoveryLimit = draft.phase === 'postprocess' ? POST_PROCESS_RECOVERY_LIMIT : Math.max(budget.recoveryLimit, 1 + selectedCount);
              const initialId = `initial:${stage.id}`;
              const isFallback = stage.id.startsWith('preprocess.cards.segmented.') && Boolean(draft.stageRecords['preprocess.cards.fused']);
              const first = !budget.reservationIds.includes(initialId);
              const cost = first && !isFallback ? 0 : 1;
              const requiredPending = runtime.graph.stages.filter((entry) =>
                entry.id.startsWith('preprocess.cards.segmented.') && entry.failurePolicy !== 'continue'
                && !['completed', 'skipped'].includes(draft.stageRecords[entry.id]?.state)).length;
              const protectedCalls = stage.failurePolicy === 'continue' && requiredPending
                ? budget.recoveryLimit - budget.recoveryUsed : 0;
              if (cost && budget.recoveryLimit - budget.recoveryUsed <= protectedCalls) {
                reservation = { ok: false, code: 'RECURSION_RECOVERY_BUDGET_EXHAUSTED', budget };
                return draft;
              }
              reservation = reserveRecoveryCall(budget, first ? initialId : `${executionToken}:${attemptContext.attempt}`,
                { cost, now: Date.parse(now()) });
              draft.recoveryBudget = reservation.budget;
              return draft;
            });
            if (!reservation) throw abortFailure();
            if (!reservation.ok) throw Object.assign(new Error('The operation recovery allowance is exhausted.'),
              { code: reservation.code, retryable: false });
            return invokeStage(attemptRequest, attemptContext.attempt);
          },
          validate: async (artifact) => {
            const started = performance.now();
            try {
              return await validateArtifact(stage, artifact, {
                context: runtime.context, dependencies: dependencyArtifacts, reuse: false
              });
            } finally { validationMs += performance.now() - started; }
          },
          buildCorrectionRequest: typeof stage.buildCorrectionRequest === 'function'
            ? (details) => stage.buildCorrectionRequest({
                ...details,
                context: runtime.context,
                dependencies: dependencyArtifacts
              })
            : ({ request: currentRequest }) => currentRequest,
          onAttemptSettled: (summary) => queueMutation(runtime, (draft) => {
            const record = draft.stageRecords[stage.id];
            if (
              !record
              || record.executionToken !== executionToken
              || record.state !== 'running'
            ) {
              return null;
            }
            const diagnosticCodes = summary.diagnosticCode
              ? [...new Set([...(record.diagnosticCodes || []), summary.diagnosticCode])]
              : (record.diagnosticCodes || []);
            const lastAttemptAction = MODEL_RETRY_ACTIONS.has(summary.action)
              ? summary.action
              : (record.lastAttemptAction || null);
            draft.stageRecords[stage.id] = {
              ...record,
              attempts: {
                ...record.attempts,
                used: Number(record.attempts.used || 0) + 1,
                total: Number(record.attempts.total || 0) + 1
              },
              diagnosticCodes,
              lastAttemptAction,
              failure: summary.failure ? failureRecord(summary.failure) : null,
              updatedAt: now()
            };
            return draft;
          })
        });
      } else {
        try {
          const artifact = await invokeStage(request);
          const validation = await validateArtifact(stage, artifact, {
            context: runtime.context,
            dependencies: dependencyArtifacts,
            reuse: false
          });
          attemptResult = validation.ok
            ? { ok: true, value: validation.value }
            : { ok: false, failure: validation.error };
        } catch (error) {
          attemptResult = error?.name === 'AbortError'
            ? { ok: false, aborted: true, failure: error }
            : { ok: false, failure: error };
        }
      }

      if (attemptResult.aborted || controller.signal.aborted) return;
      if (
        !attemptResult.ok
        && modelStage
        && typeof stage.settleExhausted === 'function'
      ) {
        const settled = await stage.settleExhausted({
          lastArtifact: attemptResult.lastResponse,
          failure: attemptResult.failure,
          attempts: attemptResult.attempts,
          request,
          context: runtime.context,
          dependencies: dependencyArtifacts
        });
        if (settled?.ok === true) {
          attemptResult = {
            ok: true,
            value: settled.value,
            attempts: attemptResult.attempts
          };
        } else if (settled?.failure) {
          attemptResult = {
            ...attemptResult,
            failure: settled.failure
          };
        }
      }
      if (!attemptResult.ok) {
        await failStage(runtime, stage, executionToken, attemptResult.failure);
        return;
      }
      if (!await canCommit(runtime, stage.id, executionToken, controller.signal)) return;

      const artifact = attemptResult.value;
      const outputHash = await stableHash(artifact);
      const artifactId = `${stage.id}.${executionToken}`;
      const persistenceStarted = performance.now();
      const savedRef = await repository.savePipelineArtifact(
        runtime.manifest.chatKey,
        runtime.manifest.operationId,
        artifactId,
        artifact
      );
      const artifactPersistenceMs = performance.now() - persistenceStarted;
      if (!savedRef || savedRef.hash !== outputHash) {
        throw Object.assign(new Error('Pipeline artifact hash verification failed.'), {
          code: 'RECURSION_STAGE_ARTIFACT_WRITE_FAILED'
        });
      }
      if (!await canCommit(runtime, stage.id, executionToken, controller.signal)) return;

      const currentRecord = runtime.manifest.stageRecords[stage.id];
      const summary = typeof stage.summarizeArtifact === 'function'
        ? await stage.summarizeArtifact(artifact, {
            context: runtime.context,
            dependencies: dependencyArtifacts
          })
        : null;
      const settledFailure = typeof stage.settledFailure === 'function'
        ? stage.settledFailure(artifact, {
            context: runtime.context,
            dependencies: dependencyArtifacts
          })
        : null;
      const checkpoint = createCheckpoint({
        operationId: runtime.manifest.operationId,
        stageId: stage.id,
        stageVersion: stage.version,
        inputHash,
        outputHash,
        dependencyHashes: Object.fromEntries(
          Object.entries(dependencyArtifacts).map(([stageId, value]) => [
            stageId,
            dependencyHash(value)
          ])
        ),
        provenance: runtime.provenance,
        attempts: currentRecord.attempts,
        diagnosticCodes: currentRecord.diagnosticCodes,
        lastAttemptAction: currentRecord.lastAttemptAction,
        artifactRef: {
          ...savedRef,
          artifactId: savedRef.artifactId || artifactId
        },
        completedAt: now()
      });
      await queueMutation(runtime, (draft) => {
        if (draft.state !== 'running') return null;
        const record = draft.stageRecords[stage.id];
        if (
          !record
          || record.executionToken !== executionToken
          || record.state !== 'running'
        ) {
          return null;
        }
        draft.stageRecords[stage.id] = {
          ...record,
          state: settledFailure ? 'failed' : 'completed',
          timings: { validationMs, artifactPersistenceMs },
          checkpoint,
          summary,
          failure: settledFailure ? failureRecord(settledFailure) : null,
          executionToken: null,
          updatedAt: now()
        };
        draft.frontierStageIds = removeValue(draft.frontierStageIds, stage.id);
        return draft;
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        const failure = {
          code: error?.code || 'RECURSION_STAGE_FAILED',
          category: /artifact|manifest|storage/i.test(String(error?.message || ''))
            ? 'storage'
            : 'internal',
          retryable: error?.retryable === true
        };
        if (runtime.manifest.stageRecords[stage.id]?.state === 'pending') {
          await failPendingStage(runtime, stage, failure);
        } else {
          await failStage(runtime, stage, executionToken, failure);
        }
      }
    } finally {
      runtime.controllers.delete(stage.id);
    }
  }

  async function markInvalidCheckpointPending(runtime, stageId) {
    await queueMutation(runtime, (draft) => {
      const record = draft.stageRecords[stageId];
      if (!record || record.state !== 'completed') return null;
      draft.stageRecords[stageId] = {
        ...record,
        state: 'pending',
        checkpoint: null,
        summary: null,
        failure: null,
        executionToken: null,
        updatedAt: now()
      };
      return draft;
    });
  }

  async function markBlockedDescendants(runtime) {
    const skipped = [];
    for (const stageId of runtime.graph.topologicalStageIds) {
      const stage = runtime.graph.getStage(stageId);
      const record = runtime.manifest.stageRecords[stageId];
      if (record.state !== 'pending') continue;
      if (stage.dependencies.some((dependencyId) => {
        const dependencyState = runtime.manifest.stageRecords[dependencyId]?.state;
        if (dependencyState === 'failed') {
          return runtime.graph.getStage(dependencyId)?.failurePolicy !== 'continue';
        }
        return ['skipped', 'stale'].includes(dependencyState);
      })) {
        skipped.push(stageId);
      }
    }
    if (skipped.length === 0) return;
    await queueMutation(runtime, (draft) => {
      for (const stageId of skipped) {
        const record = draft.stageRecords[stageId];
        if (record?.state !== 'pending') continue;
        draft.stageRecords[stageId] = {
          ...record,
          state: 'skipped',
          failure: null,
          executionToken: null,
          updatedAt: now()
        };
      }
      return draft;
    });
  }

  async function runOperation(runtime, epoch) {
    const dependencySettled = (dependencyId) => {
      const dependencyState = runtime.manifest.stageRecords[dependencyId]?.state;
      return dependencyState === 'completed'
        || (
          dependencyState === 'failed'
          && runtime.graph.getStage(dependencyId)?.failurePolicy === 'continue'
        );
    };
    while (runtime.epoch === epoch && runtime.manifest.state === 'running') {
      await markBlockedDescendants(runtime);
      if (runtime.epoch !== epoch || runtime.manifest.state !== 'running') break;

      const ready = [];
      const scheduledThisWave = new Set();
      for (const stageId of runtime.graph.topologicalStageIds) {
        const stage = runtime.graph.getStage(stageId);
        if (stage.dependencies.some((dependencyId) => scheduledThisWave.has(dependencyId))) {
          continue;
        }
        let record = runtime.manifest.stageRecords[stageId];
        if (record.state === 'completed') {
          if (!stage.dependencies.every(dependencySettled)) {
            continue;
          }
          if (runtime.forcedStageIds.has(stageId)) {
            ready.push(stage);
            scheduledThisWave.add(stageId);
            continue;
          }
          if (await reusableCheckpoint(runtime, stage)) continue;
          await markInvalidCheckpointPending(runtime, stageId);
          record = runtime.manifest.stageRecords[stageId];
        }
        if (record.state !== 'pending') continue;
        if (!stage.executable) {
          await queueMutation(runtime, (draft) => {
            const current = draft.stageRecords[stageId];
            if (current?.state !== 'pending') return null;
            draft.stageRecords[stageId] = {
              ...current,
              state: 'skipped',
              updatedAt: now()
            };
            return draft;
          });
          continue;
        }
        if (stage.dependencies.every(dependencySettled)) {
          ready.push(stage);
          scheduledThisWave.add(stageId);
        }
      }

      if (ready.length > 0) {
        if (runtime.manifest.phase === 'preprocess') {
          ready.sort((a, b) => Number(a.failurePolicy === 'continue') - Number(b.failurePolicy === 'continue'));
        }
        const wave = ready.map((stage) => {
          const promise = executeStage(runtime, stage);
          runtime.activeStagePromises.set(stage.id, promise);
          promise.finally(() => {
            if (runtime.activeStagePromises.get(stage.id) === promise) {
              runtime.activeStagePromises.delete(stage.id);
            }
          });
          return promise;
        });
        await Promise.allSettled(wave);
        continue;
      }

      const blockingFailure = runtime.graph.stages.find((stage) => (
        stage.failurePolicy !== 'continue'
        && runtime.manifest.stageRecords[stage.id]?.state === 'failed'
      ));
      if (blockingFailure) {
        await queueMutation(runtime, (draft) => {
          if (draft.state !== 'running') return null;
          draft.state = 'paused';
          draft.pauseReason = `stage-failed:${blockingFailure.id}`;
          draft.frontierStageIds = [];
          return draft;
        });
        break;
      }

      const records = Object.values(runtime.manifest.stageRecords);
      if (records.every((record) => ['completed', 'failed', 'skipped'].includes(record.state))) {
        await queueMutation(runtime, (draft) => {
          if (draft.state !== 'running') return null;
          draft.state = 'completed';
          draft.pauseReason = '';
          draft.frontierStageIds = [];
          return draft;
        });
        break;
      }

      await queueMutation(runtime, (draft) => {
        if (draft.state !== 'running') return null;
        draft.state = 'paused';
        draft.pauseReason = 'scheduler-blocked';
        draft.frontierStageIds = [];
        return draft;
      });
      break;
    }
    if (runtime.transitionPromise) await runtime.transitionPromise;
    return clone(runtime.manifest);
  }

  function activate(runtime) {
    runtime.epoch += 1;
    const epoch = runtime.epoch;
    clearTimeout(runtime.deadlineTimer);
    runtime.deadlineTimer = runtime.manifest.recoveryBudget ? setTimeout(() => {
      if (runtime.epoch !== epoch || runtime.manifest.state !== 'running') return;
      void pauseRuntime(runtime, 'operation-deadline').catch(() => {
        for (const controller of runtime.controllers.values()) controller.abort();
      });
    }, remainingExecutionMs(runtime.manifest.recoveryBudget, Date.parse(now()))) : null;
    runtime.deadlineTimer?.unref?.();
    const promise = runOperation(runtime, epoch).finally(() => {
      if (runtime.promise === promise) {
        runtime.promise = null;
        clearTimeout(runtime.deadlineTimer);
      }
    });
    runtime.promise = promise;
    return promise;
  }

  function runtimeForOperation(operationId) {
    return operations.get(String(operationId || '')) || null;
  }

  async function pauseRuntime(runtime, reason, state = 'paused') {
    runtime.epoch += 1;
    await queueMutation(runtime, (draft) => {
      if (isTerminalOperationState(draft.state)) return null;
      draft.state = state;
      draft.pauseReason = String(reason || (state === 'abandoned' ? 'abandoned' : 'paused')).slice(0, 120);
      return draft;
    });
    for (const controller of runtime.controllers.values()) controller.abort();
    await Promise.allSettled([...runtime.activeStagePromises.values()]);
    await queueMutation(runtime, (draft) => {
      let changed = false;
      const interruptedStageIds = [];
      for (const [stageId, record] of Object.entries(draft.stageRecords)) {
        if (record.state !== 'running') continue;
        interruptedStageIds.push(stageId);
        draft.stageRecords[stageId] = {
          ...record,
          state: 'pending',
          checkpoint: null,
          summary: null,
          executionToken: null,
          updatedAt: now()
        };
        changed = true;
      }
      if (!changed && draft.frontierStageIds.length === 0) return null;
      draft.frontierStageIds = [
        ...new Set([...draft.frontierStageIds, ...interruptedStageIds])
      ];
      return draft;
    });
    return clone(runtime.manifest);
  }

  function makeRuntime(manifestValue, graph, context, provenance) {
    const normalized = normalizePipelineRun(manifestValue);
    if (!normalized) throw new TypeError('Scheduler requires a valid pipeline manifest.');
    const limit = attemptLimit();
    normalized.stageRecords = graphStageRecords(normalized, graph, limit, now());
    normalized.recoveryBudget = ['preprocess', 'postprocess'].includes(normalized.phase) ? normalizeOperationBudget(normalized.recoveryBudget, {
      recoveryLimit: normalized.phase === 'postprocess' ? POST_PROCESS_RECOVERY_LIMIT : 1,
      windowId: normalized.operationId,
      deadlineMs: (context?.settings?.operationDeadlineSeconds || 300) * 1000
    }) : null;
    return {
      manifest: normalized,
      graph,
      context,
      provenance: normalizeExecutionProvenance(provenance || normalized.provenance),
      forcedStageIds: new Set(normalized.queuedStageIds),
      queuedStageIds: new Set(normalized.queuedStageIds),
      controllers: new Map(),
      activeStagePromises: new Map(),
      mutationTail: Promise.resolve(),
      promise: null,
      transitionPromise: null,
      epoch: 0
    };
  }

  function start({ manifest: manifestValue, graph, context = {} } = {}) {
    return (async () => {
      const incoming = normalizePipelineRun(manifestValue);
      if (!incoming || !graph) throw new TypeError('Scheduler start requires manifest and graph.');
      const existingStored = await repository.loadPipelineRun(incoming.chatKey);
      if (
        existingStored
        && existingStored.operationId !== incoming.operationId
        && !isTerminalOperationState(existingStored.state)
      ) {
        const activeRuntime = runtimeForOperation(existingStored.operationId);
        if (activeRuntime) {
          await pauseRuntime(activeRuntime, 'superseded-by-new-operation', 'abandoned');
        } else {
          await saveStandalone(existingStored, {
            state: 'abandoned',
            pauseReason: 'superseded-by-new-operation',
            frontierStageIds: []
          });
        }
      }

      const runtime = makeRuntime(incoming, graph, context, incoming.provenance);
      runtime.manifest = normalizePipelineRun({
        ...runtime.manifest,
        recoveryBudget: runtime.manifest.recoveryBudget ? settleOperationClock(runtime.manifest.recoveryBudget, true, Date.parse(now())) : null,
        state: 'running',
        pauseReason: '',
        revision: Number(runtime.manifest.revision || 0) + 1,
        updatedAt: now()
      });
      await repository.savePipelineRun(runtime.manifest.chatKey, runtime.manifest);
      operations.set(runtime.manifest.operationId, runtime);
      operationByChat.set(runtime.manifest.chatKey, runtime.manifest.operationId);
      publish(runtime);
      return activate(runtime);
    })().then((value) => value);
  }

  function pause({ operationId, reason = 'user' } = {}) {
    const runtime = runtimeForOperation(operationId);
    if (!runtime) return Promise.resolve(null);
    if (runtime.transitionPromise) return runtime.transitionPromise;
    const transition = pauseRuntime(runtime, reason).finally(() => {
      if (runtime.transitionPromise === transition) runtime.transitionPromise = null;
    });
    runtime.transitionPromise = transition;
    return transition;
  }

  function resume({ operationId, graph, context = {}, provenance } = {}) {
    let runtime = runtimeForOperation(operationId);
    if (resumeTransitions.has(operationId)) return resumeTransitions.get(operationId);
    const transition = (async () => {
      const expectedProvenance = normalizeExecutionProvenance(provenance);
      const chatKey = runtime?.manifest.chatKey || expectedProvenance.chatKey;
      const loaded = chatKey ? await repository.loadPipelineRun(chatKey) : null;
      let manifestToResume = loaded;
      if (!manifestToResume && runtime) manifestToResume = runtime.manifest;
      if (!manifestToResume) {
        for (const candidate of operations.values()) {
          if (candidate.manifest.operationId === operationId) {
            manifestToResume = await repository.loadPipelineRun(candidate.manifest.chatKey);
            runtime = candidate;
            break;
          }
        }
      }
      if (!manifestToResume || manifestToResume.operationId !== operationId) {
        throw new Error('Pipeline operation is unavailable for Resume.');
      }
      const status = compareRunProvenance(expectedProvenance, manifestToResume.provenance);
      if (!status.reusable) {
        const stale = await saveStandalone(manifestToResume, {
          state: 'stale',
          pauseReason: 'provenance-changed',
          staleChangedFields: status.changedFields,
          frontierStageIds: []
        });
        if (runtime) runtime.manifest = normalizePipelineRun(stale);
        return { ok: false, stale: true, changedFields: status.changedFields };
      }
      if (manifestToResume.state === 'stale' || manifestToResume.state === 'abandoned') {
        return { ok: false, stale: manifestToResume.state === 'stale' };
      }
      if (manifestToResume.state === 'completed') return clone(manifestToResume);

      if (!runtime) {
        runtime = makeRuntime(manifestToResume, graph, context, expectedProvenance);
        operations.set(operationId, runtime);
        operationByChat.set(runtime.manifest.chatKey, operationId);
      } else {
        runtime.manifest = normalizePipelineRun(manifestToResume);
        runtime.graph = graph || runtime.graph;
        runtime.manifest.stageRecords = graphStageRecords(
          runtime.manifest,
          runtime.graph,
          attemptLimit(),
          now()
        );
        runtime.context = context;
        runtime.provenance = expectedProvenance;
        runtime.forcedStageIds = new Set(runtime.manifest.queuedStageIds);
        runtime.queuedStageIds = new Set(runtime.manifest.queuedStageIds);
      }
      await queueMutation(runtime, (draft) => {
        draft.state = 'running';
        draft.pauseReason = '';
        draft.staleChangedFields = [];
        if (draft.queuedStageIds.length && ['reprocess', 'full-fresh'].includes(runtime.manifest.pauseReason)) {
          draft.recoveryBudget = ['preprocess', 'postprocess'].includes(draft.phase) ? normalizeOperationBudget(null, {
            recoveryLimit: draft.phase === 'postprocess' ? POST_PROCESS_RECOVERY_LIMIT : 1,
            windowId: createId('recovery-window'),
            deadlineMs: draft.recoveryBudget?.deadlineMs
          }) : null;
        }
        return draft;
      });
      return activate(runtime);
    })();
    resumeTransitions.set(operationId, transition);
    const clearTransition = () => {
      if (resumeTransitions.get(operationId) === transition) {
        resumeTransitions.delete(operationId);
      }
    };
    void transition.then(clearTransition, clearTransition);
    return transition;
  }

  function retry({ operationId, stageId, graph, context = {}, provenance } = {}) {
    if (resumeTransitions.has(operationId)) return resumeTransitions.get(operationId);
    const transition = (async () => {
      let runtime = runtimeForOperation(operationId);
      const expectedProvenance = normalizeExecutionProvenance(provenance);
      const chatKey = runtime?.manifest.chatKey || expectedProvenance.chatKey;
      const loaded = chatKey ? await repository.loadPipelineRun(chatKey) : null;
      if (!loaded || loaded.operationId !== operationId) {
        throw new Error('Pipeline operation is unavailable for Retry.');
      }
      if (!runtime) {
        if (!graph) throw new Error('Pipeline operation graph is unavailable for Retry.');
        runtime = makeRuntime(loaded, graph, context, expectedProvenance);
        operations.set(operationId, runtime);
        operationByChat.set(runtime.manifest.chatKey, operationId);
      }
      const status = compareRunProvenance(expectedProvenance, loaded.provenance);
      if (!status.reusable) {
        const stale = await saveStandalone(loaded, {
          state: 'stale',
          pauseReason: 'provenance-changed',
          staleChangedFields: status.changedFields,
          frontierStageIds: []
        });
        runtime.manifest = normalizePipelineRun(stale);
        return { ok: false, stale: true, changedFields: status.changedFields };
      }
      const stage = (graph || runtime.graph).getStage(stageId);
      const record = loaded.stageRecords?.[stageId];
      if (
        !stage
        || stage.failurePolicy === 'continue'
        || loaded.state !== 'paused'
        || record?.state !== 'failed'
      ) {
        throw new Error('Retry is valid only for the blocking failed stage.');
      }
      runtime.manifest = normalizePipelineRun(loaded);
      runtime.graph = graph || runtime.graph;
      runtime.context = context;
      runtime.provenance = expectedProvenance;
      const retryFromStageId = stage.retryFromStageId || stageId;
      runtime.forcedStageIds = new Set([retryFromStageId]);
      runtime.queuedStageIds = new Set();
      await queueMutation(runtime, (draft) => {
        draft.recoveryBudget = ['preprocess', 'postprocess'].includes(draft.phase) ? normalizeOperationBudget(null, {
          recoveryLimit: draft.phase === 'postprocess' ? POST_PROCESS_RECOVERY_LIMIT : 1,
          windowId: createId('recovery-window'),
          deadlineMs: draft.recoveryBudget?.deadlineMs
        }) : null;
        draft.state = 'running';
        draft.pauseReason = '';
        draft.staleChangedFields = [];
        for (const descendantId of [retryFromStageId, ...runtime.graph.descendantIds(retryFromStageId)]) {
          const descendant = draft.stageRecords[descendantId];
          if (!descendant) continue;
          draft.stageRecords[descendantId] = {
            ...descendant,
            state: 'pending',
            checkpoint: null,
            summary: null,
            failure: null,
            executionToken: null,
            updatedAt: now()
          };
        }
        return draft;
      });
      return activate(runtime);
    })();
    resumeTransitions.set(operationId, transition);
    const clearTransition = () => {
      if (resumeTransitions.get(operationId) === transition) {
        resumeTransitions.delete(operationId);
      }
    };
    void transition.then(clearTransition, clearTransition);
    return transition;
  }

  function abandon({ operationId, reason = 'user' } = {}) {
    const runtime = runtimeForOperation(operationId);
    if (!runtime) return Promise.resolve(null);
    return pauseRuntime(runtime, reason, 'abandoned');
  }

  function getActiveOperation(operationId = null) {
    if (operationId) return clone(runtimeForOperation(operationId)?.manifest || null);
    const active = [...operations.values()].filter((runtime) => (
      !isTerminalOperationState(runtime.manifest.state)
    ));
    return active.length === 1 ? clone(active[0].manifest) : active.map((runtime) => clone(runtime.manifest));
  }

  return {
    start,
    pause,
    resume,
    retry,
    abandon,
    getActiveOperation
  };
}
