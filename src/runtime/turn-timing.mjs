export function createTurnTimingTracker({ now = Date.now } = {}) {
  let current = null;
  function snapshot() {
    if (!current) return null;
    const duration = (start, end) => start === null || end === null || end < start ? null : end - start;
    return { ...current,
      preprocessMs: current.preparedAt === null ? null : current.preparedAt - current.startedAt,
      firstVisibleTokenMs: current.firstVisibleTokenAt === null ? null : current.firstVisibleTokenAt - current.startedAt,
      totalReplyMs: current.completedAt === null ? null : current.completedAt - current.startedAt,
      preparedToRequestReadyMs: duration(current.preparedAt, current.hostRequestReadyAt),
      requestReadyToFirstVisibleTokenMs: duration(current.hostRequestReadyAt, current.firstVisibleTokenAt),
      postPreparationMs: duration(current.preparedAt, current.firstVisibleTokenAt),
      visibleStreamingMs: duration(current.firstVisibleTokenAt, current.completedAt)
    };
  }
  return {
    start(attemptId) {
      current = { attemptId, operationId: '', chatKey: '', turnKeyHash: '',
        startedAt: now(), preparedAt: null, firstVisibleTokenAt: null, completedAt: null,
        hostRequestReadyAt: null, hostRequestReadySource: '',
        unavailableReason: 'primary-not-observed', invalidated: false };
      return snapshot();
    },
    mark(attemptId, event, details = {}) {
      if (!current || current.attemptId !== attemptId || current.invalidated || current.completedAt !== null) return false;
      if (event === 'prepared') {
        current.preparedAt ??= now();
        for (const key of ['operationId', 'chatKey', 'turnKeyHash']) current[key] = String(details[key] || '').slice(0, 180);
      } else if (event === 'host-request-ready' && current.preparedAt !== null) {
        if (!['normal', 'swipe', 'continue', 'regenerate'].includes(details.generationType)) return false;
        if (details.source !== 'chat-completion-settings-ready') return false;
        if (current.hostRequestReadyAt !== null || current.firstVisibleTokenAt !== null) return false;
        current.hostRequestReadyAt = now();
        current.hostRequestReadySource = details.source === 'chat-completion-settings-ready' ? details.source : '';
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
