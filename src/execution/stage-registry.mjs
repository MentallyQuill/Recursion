function cleanId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStage(stage) {
  if (!stage || typeof stage !== 'object' || Array.isArray(stage)) {
    throw new TypeError('Execution stages must be objects.');
  }
  const id = cleanId(stage.id);
  if (!id) throw new TypeError('Execution stage id is required.');
  const dependencies = [...new Set(
    (Array.isArray(stage.dependencies) ? stage.dependencies : [])
      .map(cleanId)
      .filter(Boolean)
  )];
  if (dependencies.includes(id)) {
    throw new TypeError(`Execution graph cycle includes "${id}".`);
  }
  return Object.freeze({
    ...stage,
    id,
    version: Number.isInteger(stage.version) && stage.version > 0 ? stage.version : 1,
    kind: cleanId(stage.kind) || 'local',
    executable: stage.executable !== false,
    dependencies: Object.freeze(dependencies),
    checkpoint: stage.checkpoint === 'none' ? 'none' : 'durable',
    failurePolicy: stage.failurePolicy === 'continue' ? 'continue' : 'blocking'
  });
}

function orderedByTopological(ids, topologicalStageIds) {
  const selected = new Set(ids);
  return topologicalStageIds.filter((stageId) => selected.has(stageId));
}

export function createExecutionGraph({ stages = [] } = {}) {
  if (!Array.isArray(stages)) throw new TypeError('Execution graph stages must be an array.');
  const normalizedStages = stages.map(normalizeStage);
  const stageById = new Map();
  for (const stage of normalizedStages) {
    if (stageById.has(stage.id)) {
      throw new TypeError(`Execution graph has duplicate stage id "${stage.id}".`);
    }
    stageById.set(stage.id, stage);
  }

  const dependentsById = new Map(normalizedStages.map((stage) => [stage.id, []]));
  const indegree = new Map(normalizedStages.map((stage) => [stage.id, stage.dependencies.length]));
  for (const stage of normalizedStages) {
    for (const dependencyId of stage.dependencies) {
      if (!stageById.has(dependencyId)) {
        throw new TypeError(`Execution stage "${stage.id}" has missing dependency "${dependencyId}".`);
      }
      dependentsById.get(dependencyId).push(stage.id);
    }
  }

  const inputOrder = new Map(normalizedStages.map((stage, index) => [stage.id, index]));
  const ready = normalizedStages
    .filter((stage) => indegree.get(stage.id) === 0)
    .map((stage) => stage.id);
  const topologicalStageIds = [];
  while (ready.length > 0) {
    ready.sort((left, right) => inputOrder.get(left) - inputOrder.get(right));
    const stageId = ready.shift();
    topologicalStageIds.push(stageId);
    for (const dependentId of dependentsById.get(stageId)) {
      indegree.set(dependentId, indegree.get(dependentId) - 1);
      if (indegree.get(dependentId) === 0) ready.push(dependentId);
    }
  }
  if (topologicalStageIds.length !== normalizedStages.length) {
    throw new TypeError('Execution graph contains a dependency cycle.');
  }

  const descendantsById = new Map();
  const ancestorsById = new Map();
  for (const stageId of topologicalStageIds) {
    const descendants = new Set();
    const queue = [...dependentsById.get(stageId)];
    while (queue.length > 0) {
      const nextId = queue.shift();
      if (descendants.has(nextId)) continue;
      descendants.add(nextId);
      queue.push(...dependentsById.get(nextId));
    }
    descendantsById.set(stageId, orderedByTopological(descendants, topologicalStageIds));

    const ancestors = new Set();
    const ancestorQueue = [...stageById.get(stageId).dependencies];
    while (ancestorQueue.length > 0) {
      const nextId = ancestorQueue.shift();
      if (ancestors.has(nextId)) continue;
      ancestors.add(nextId);
      ancestorQueue.push(...stageById.get(nextId).dependencies);
    }
    ancestorsById.set(stageId, orderedByTopological(ancestors, topologicalStageIds));
  }

  for (const [stageId, ids] of dependentsById) {
    dependentsById.set(stageId, Object.freeze(orderedByTopological(ids, topologicalStageIds)));
  }

  const executableStageIds = Object.freeze(
    topologicalStageIds.filter((stageId) => stageById.get(stageId).executable)
  );
  return Object.freeze({
    stages: Object.freeze(topologicalStageIds.map((stageId) => stageById.get(stageId))),
    topologicalStageIds: Object.freeze([...topologicalStageIds]),
    executableStageIds,
    rootStageIds: Object.freeze(
      topologicalStageIds.filter((stageId) => stageById.get(stageId).dependencies.length === 0)
    ),
    getStage(stageId) {
      return stageById.get(cleanId(stageId)) || null;
    },
    hasStage(stageId) {
      return stageById.has(cleanId(stageId));
    },
    dependentIds(stageId) {
      return [...(dependentsById.get(cleanId(stageId)) || [])];
    },
    descendantIds(stageId) {
      return [...(descendantsById.get(cleanId(stageId)) || [])];
    },
    ancestorIds(stageId) {
      return [...(ancestorsById.get(cleanId(stageId)) || [])];
    }
  });
}
