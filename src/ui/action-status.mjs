function safeMessage(error) {
  const message = String(error?.message || error || '').trim();
  if (!message) return 'Action failed.';
  return message.length > 120 ? `${message.slice(0, 117)}...` : message;
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
