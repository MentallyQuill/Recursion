import { failureFrom } from '../failures.mjs';

function safeMessage(error) {
  const message = String(error?.message || error || '').trim();
  if (!message) return 'Action failed.';
  return message.length > 120 ? `${message.slice(0, 117)}...` : message;
}

function safeSeverity(value) {
  const severity = String(value || '').trim().toLowerCase();
  return ['info', 'success', 'warning', 'error'].includes(severity) ? severity : 'info';
}

export function normalizeUiActionFailure(error, fallback = 'Action failed.') {
  const failure = failureFrom(error, {
    code: 'RECURSION_UI_ACTION_FAILED',
    stage: 'ui-action',
    category: 'internal'
  });
  return {
    severity: 'warning',
    label: failure.message,
    failure
  };
}

export function createUiActionStatus() {
  let current = null;
  return {
    set(label, severity = 'info') {
      const message = safeMessage(label || 'Action complete.');
      current = {
        severity: safeSeverity(severity),
        label: message === 'Action failed.' ? 'Action complete.' : message
      };
      return current;
    },
    setFailure(error, fallback) {
      current = normalizeUiActionFailure(error, fallback);
      return current;
    },
    clear() {
      current = null;
    },
    current() {
      return current ? { ...current } : null;
    }
  };
}

export function progressActionControl(action) {
  if (!action || typeof action !== 'object' || !String(action.kind || '').trim()) return null;
  const label = String(action.label || '').trim();
  const stageId = String(action.stageId || '').trim();
  if (!label || !stageId) return null;
  return {
    tagName: 'button',
    className: 'recursion-progress-action',
    attrs: {
      type: 'button',
      'aria-label': label,
      title: label
    },
    dataset: {
      recursionProgressAction: String(action.kind),
      recursionProgressStageId: stageId,
      recursionProgressOperationId: String(action.operationId || '').trim(),
      recursionProgressActionIcon: String(action.icon || '').trim()
    }
  };
}

export function isProgressActionActivation(event) {
  return event?.key === 'Enter' || event?.key === ' ';
}

export function dispatchProgressAction(runtime, action) {
  const source = action && typeof action === 'object' ? action : {};
  const operationId = String(source.operationId || '').trim();
  const stageId = String(source.stageId || '').trim();
  if (source.kind === 'stop') {
    return runtime?.pauseOperation?.({ reason: 'user' });
  }
  if (source.kind === 'resume') {
    return runtime?.resumeOperation?.({ operationId });
  }
  if (source.kind === 'retry') {
    return runtime?.retryStage?.({ operationId, stageId });
  }
  if (source.kind === 'reprocess') {
    return runtime?.queueStageReprocess?.({ stageId });
  }
  if (source.kind === 'cancel-reprocess') {
    return runtime?.cancelQueuedStageReprocess?.({ stageId });
  }
  return null;
}
