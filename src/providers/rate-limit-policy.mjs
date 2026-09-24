// Capacity retries have their own bound; they do not consume model corrections.
// The scheduler's operation deadline and Stop signal also bound every wait.
export const RATE_LIMIT_RETRY_LIMIT = 8;

export function rateLimitDelay(retryAfterMs, failureCount = 1) {
  const backoff = Math.min(60000, 2000 * (2 ** Math.min(5, Math.max(0, failureCount - 1))));
  const supplied = Number(retryAfterMs);
  return Math.min(2147483647, Math.max(backoff, Number.isFinite(supplied) ? supplied : 0));
}
