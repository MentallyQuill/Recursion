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
  const message = safeMessage(error);
  return {
    severity: 'warning',
    label: message === 'Action failed.' ? fallback : message
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
