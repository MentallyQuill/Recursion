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
