export function createRuntimeRunState() {
  let activeRunId = null;
  let activeRunController = null;
  let activeRapidWarmRun = null;
  let activeAttempt = null;
  let hostGenerationActive = false;
  const activeRuntimeMutations = new Set();
  let activePromptMutationId = null;
  let pendingLatestAssistantSwipeRetry = null;
  let pendingFreshNextGeneration = null;

  return {
    current() {
      return {
        activeRunId,
        activeRunController,
        activeRapidWarmRun,
        activeAttempt,
        hostGenerationActive,
        activeRuntimeMutations: activeRuntimeMutations.size,
        activeRuntimeMutationSet: activeRuntimeMutations,
        activePromptMutationId,
        pendingLatestAssistantSwipeRetry,
        pendingFreshNextGeneration
      };
    },
    setActiveRun(runId, controller = null) {
      activeRunId = runId || null;
      activeRunController = controller || null;
    },
    clearActiveRun(runId = activeRunId) {
      if (!runId || runId === activeRunId) {
        activeRunId = null;
        activeRunController = null;
      }
    },
    beginAttempt(attempt = {}) {
      activeAttempt = {
        runId: String(attempt.runId || ''),
        kind: ['normal', 'swipe', 'fresh'].includes(attempt.kind) ? attempt.kind : 'normal',
        sourceRevisionHash: String(attempt.sourceRevisionHash || ''),
        packetId: String(attempt.packetId || ''),
        startedAt: String(attempt.startedAt || new Date().toISOString()),
        canceled: false
      };
      return activeAttempt;
    },
    cancelAttempt(runId = activeAttempt?.runId, reason = 'host-generation-stopped') {
      if (!activeAttempt || (runId && String(runId) !== activeAttempt.runId)) return null;
      activeAttempt = { ...activeAttempt, canceled: true, cancelReason: String(reason || '') };
      return activeAttempt;
    },
    clearAttempt(runId = activeAttempt?.runId) {
      if (!runId || activeAttempt?.runId === String(runId)) activeAttempt = null;
    },
    setHostGenerationActive(value) {
      hostGenerationActive = Boolean(value);
    },
    addRuntimeMutation(promise) {
      if (promise) activeRuntimeMutations.add(promise);
      return activeRuntimeMutations.size;
    },
    deleteRuntimeMutation(promise) {
      if (promise) activeRuntimeMutations.delete(promise);
      return activeRuntimeMutations.size;
    },
    beginRuntimeMutation() {
      const token = {};
      activeRuntimeMutations.add(token);
      return token;
    },
    endRuntimeMutation(token) {
      if (token) activeRuntimeMutations.delete(token);
      return activeRuntimeMutations.size;
    },
    runtimeMutations() {
      return [...activeRuntimeMutations];
    },
    runtimeMutationCount() {
      return activeRuntimeMutations.size;
    },
    setPromptMutation(id) {
      activePromptMutationId = id || null;
    },
    clearPromptMutation(id = activePromptMutationId) {
      if (!id || activePromptMutationId === id) activePromptMutationId = null;
    },
    setRapidWarmRun(run) {
      activeRapidWarmRun = run || null;
    },
    mutateRapidWarmRun(mutator) {
      if (!activeRapidWarmRun || typeof mutator !== 'function') return activeRapidWarmRun;
      mutator(activeRapidWarmRun);
      return activeRapidWarmRun;
    },
    clearRapidWarmRun(runId = activeRapidWarmRun?.runId) {
      if (!runId || activeRapidWarmRun?.runId === runId) activeRapidWarmRun = null;
    },
    setLatestAssistantSwipeRetry(retry) {
      pendingLatestAssistantSwipeRetry = retry || null;
    },
    takeLatestAssistantSwipeRetry() {
      const retry = pendingLatestAssistantSwipeRetry;
      pendingLatestAssistantSwipeRetry = null;
      return retry || null;
    },
    clearLatestAssistantSwipeRetry() {
      pendingLatestAssistantSwipeRetry = null;
    },
    setFreshNextGeneration(token) {
      pendingFreshNextGeneration = token || null;
    },
    takeFreshNextGeneration() {
      const token = pendingFreshNextGeneration;
      pendingFreshNextGeneration = null;
      return token || null;
    },
    clearFreshNextGeneration() {
      pendingFreshNextGeneration = null;
    }
  };
}
