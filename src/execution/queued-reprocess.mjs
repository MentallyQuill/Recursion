import { compareRunProvenance } from './provenance.mjs';

export const QUEUED_REPROCESS_SCHEMA = 'recursion.queued-reprocess.v1';

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanStageIds(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((stageId) => typeof stageId === 'string' ? stageId.trim() : '')
      .filter(Boolean)
  )];
}

function orderedStageIds(graph, stageIds) {
  const selected = new Set(stageIds);
  return graph.topologicalStageIds.filter((stageId) => selected.has(stageId));
}

function selectedRoots(graph, stageIds) {
  const selected = new Set(stageIds);
  return orderedStageIds(
    graph,
    stageIds.filter((stageId) => (
      !graph.ancestorIds(stageId).some((ancestorId) => selected.has(ancestorId))
    ))
  );
}

export function normalizeQueuedReprocess(value) {
  if (!isObject(value)) return null;
  if (value.schema !== undefined && value.schema !== QUEUED_REPROCESS_SCHEMA) return null;
  if (value.mode === 'canceled') {
    return {
      schema: QUEUED_REPROCESS_SCHEMA,
      mode: 'canceled',
      stageIds: []
    };
  }
  if (value.mode === 'full-fresh') {
    return {
      schema: QUEUED_REPROCESS_SCHEMA,
      mode: 'full-fresh',
      stageIds: []
    };
  }
  const stageIds = cleanStageIds(value.stageIds);
  if (stageIds.length === 0) return null;
  return {
    schema: QUEUED_REPROCESS_SCHEMA,
    mode: 'stage',
    stageIds
  };
}

export function mergeQueuedReprocess(current, next, graph) {
  const left = normalizeQueuedReprocess(current);
  const right = normalizeQueuedReprocess(next);
  if (right?.mode === 'canceled') return right;
  if (left?.mode === 'full-fresh' || right?.mode === 'full-fresh') {
    return {
      schema: QUEUED_REPROCESS_SCHEMA,
      mode: 'full-fresh',
      stageIds: []
    };
  }
  const stageIds = selectedRoots(graph, [
    ...(left?.mode === 'stage' ? left.stageIds : []),
    ...(right?.mode === 'stage' ? right.stageIds : [])
  ].filter((stageId) => graph.hasStage(stageId)));
  return stageIds.length > 0
    ? {
        schema: QUEUED_REPROCESS_SCHEMA,
        mode: 'stage',
        stageIds
      }
    : null;
}

export function planReprocess({
  graph,
  manifest,
  selectedStageIds = [],
  fullFresh = false
} = {}) {
  const selected = selectedRoots(
    graph,
    cleanStageIds(selectedStageIds).filter((stageId) => (
      graph.hasStage(stageId) && graph.getStage(stageId).executable
    ))
  );
  const forcedStageIds = fullFresh ? [...graph.executableStageIds] : selected;
  const invalidated = new Set(forcedStageIds);
  const reusableStageIds = fullFresh
    ? []
    : graph.topologicalStageIds.filter((stageId) => (
        !invalidated.has(stageId)
        && manifest?.stageRecords?.[stageId]?.state === 'completed'
        && manifest.stageRecords[stageId].checkpoint
      ));
  return {
    selectedStageIds: selected,
    forcedStageIds,
    reusableStageIds,
    invalidatedStageIds: orderedStageIds(graph, invalidated),
    bypassAllCheckpoints: Boolean(fullFresh)
  };
}

export function bindQueuedReprocess({
  intent,
  graph,
  manifest,
  provenance
} = {}) {
  const normalized = normalizeQueuedReprocess(intent);
  const baseManifest = {
    ...manifest,
    queuedStageIds: []
  };
  if (!normalized || normalized.mode === 'canceled') {
    return { manifest: baseManifest, intent: null, notices: [] };
  }

  const candidateIds = normalized.mode === 'full-fresh'
    ? [...graph.executableStageIds]
    : normalized.stageIds;
  const applicableIds = candidateIds.filter((stageId) => (
    graph.hasStage(stageId) && graph.getStage(stageId).executable
  ));
  const inapplicableIds = candidateIds.filter((stageId) => !applicableIds.includes(stageId));
  const queuedStageIds = normalized.mode === 'full-fresh'
    ? applicableIds
    : selectedRoots(graph, applicableIds);
  const notices = inapplicableIds.length > 0
    ? [{
        code: 'stage-reprocess-inapplicable',
        stageIds: inapplicableIds.slice(0, 20)
      }]
    : [];
  if (queuedStageIds.length === 0) {
    return { manifest: baseManifest, intent: null, notices };
  }

  const manifestProvenance = isObject(manifest?.provenance) ? manifest.provenance : provenance;
  const provenanceStatus = compareRunProvenance(provenance || {}, manifestProvenance || {});
  if (!provenanceStatus.reusable) {
    return {
      manifest: {
        ...baseManifest,
        state: 'stale',
        pauseReason: 'provenance-changed',
        staleChangedFields: provenanceStatus.changedFields
      },
      intent: normalized,
      notices
    };
  }

  return {
    manifest: {
      ...baseManifest,
      queuedStageIds
    },
    intent: normalized.mode === 'stage'
      ? { ...normalized, stageIds: queuedStageIds }
      : normalized,
    notices
  };
}

export function consumeQueuedStageStart({ intent, stageId } = {}) {
  const normalized = normalizeQueuedReprocess(intent);
  if (!normalized || normalized.mode === 'canceled') {
    return { consumed: false, intent: null };
  }
  if (normalized.mode === 'full-fresh') {
    return { consumed: true, intent: null };
  }
  if (!normalized.stageIds.includes(stageId)) {
    return { consumed: false, intent: normalized };
  }
  const stageIds = normalized.stageIds.filter((selectedId) => selectedId !== stageId);
  return {
    consumed: true,
    intent: stageIds.length > 0 ? { ...normalized, stageIds } : null
  };
}
