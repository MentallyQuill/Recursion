export function createTurnTimingTracker({ now = Date.now } = {}) {
  let current = null;
  function snapshot() {
    if (!current) return null;
    return { ...current,
      preprocessMs: current.preparedAt === null ? null : current.preparedAt - current.startedAt,
      firstVisibleTokenMs: current.firstVisibleTokenAt === null ? null : current.firstVisibleTokenAt - current.startedAt,
      totalReplyMs: current.completedAt === null ? null : current.completedAt - current.startedAt
    };
  }
  return {
    start(attemptId) {
      current = { attemptId, operationId: '', chatKey: '', turnKeyHash: '',
        startedAt: now(), preparedAt: null, firstVisibleTokenAt: null, completedAt: null,
        unavailableReason: 'primary-not-observed', invalidated: false };
      return snapshot();
    },
    mark(attemptId, event, details = {}) {
      if (!current || current.attemptId !== attemptId || current.invalidated || current.completedAt !== null) return false;
      if (event === 'prepared') {
        current.preparedAt ??= now();
        for (const key of ['operationId', 'chatKey', 'turnKeyHash']) current[key] = String(details[key] || '').slice(0, 180);
      } else if (event === 'first-visible-token' && current.preparedAt !== null) {
        if (current.firstVisibleTokenAt !== null) return false;
        current.firstVisibleTokenAt = now();
        current.unavailableReason = '';
      } else if (event === 'completed' && current.preparedAt !== null) {
        current.completedAt = now();
        if (current.firstVisibleTokenAt === null) current.unavailableReason = 'no-visible-stream-event';
      } else if (event === 'invalidate') {
        current.invalidated = true;
        current.unavailableReason = String(details.reason || 'source-changed').slice(0, 100);
      } else return false;
      return true;
    },
    snapshot
  };
}
