// The runtime has already sanitized this payload. Preserve its complete JSON.
export function downloadDiagnostics(payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `recursion-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  anchor.hidden = true;
  try {
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Allow mobile browsers time to consume the URL before releasing it.
    const cleanup = setTimeout(() => URL.revokeObjectURL(url), 60000);
    cleanup?.unref?.();
  }
}
